import { describe, expect, it } from "vitest";

import type { PluginContext } from "./ccgui-plugin";
import {
  parseClaudeCredentials,
  parseClaudeOauthUsage,
  readClaudeOauthUsage,
} from "./claude-oauth";

describe("Claude subscription usage (api/oauth/usage)", () => {
  it("parses the five-hour and weekly windows into structured rows", () => {
    // 形状取自官方 CLI 二进制内该接口的解析代码：utilization 为 0–1 小数，
    // resets_at 为秒级纪元；窗口键固定为 five_hour / seven_day。
    const body = JSON.stringify({
      five_hour: { utilization: 0.41, resets_at: 1_790_000_000 },
      seven_day: { utilization: 0.17, resets_at: 1_790_300_000 },
    });

    expect(parseClaudeOauthUsage(body)).toEqual([
      { durationMins: 300, usedPercent: 41, resetsAtMs: 1_790_000_000_000 },
      { durationMins: 10_080, usedPercent: 17, resetsAtMs: 1_790_300_000_000 },
    ]);
  });

  it("accepts ISO-8601 reset timestamps and skips windows the plan lacks", () => {
    const body = JSON.stringify({
      seven_day: { utilization: 0.5, resets_at: "2026-09-27T00:00:00.000Z" },
    });

    expect(parseClaudeOauthUsage(body)).toEqual([
      {
        durationMins: 10_080,
        usedPercent: 50,
        resetsAtMs: Date.parse("2026-09-27T00:00:00.000Z"),
      },
    ]);
  });

  it("returns null when no usable window is present", () => {
    expect(parseClaudeOauthUsage("{}")).toBeNull();
    expect(parseClaudeOauthUsage("not json at all")).toBeNull();
    expect(
      parseClaudeOauthUsage(JSON.stringify({ five_hour: { utilization: "many" } })),
    ).toBeNull();
  });

  it("clamps out-of-range utilization into 0–100", () => {
    const body = JSON.stringify({
      five_hour: { utilization: 1.4, resets_at: null },
      seven_day: { utilization: -0.2, resets_at: null },
    });

    expect(parseClaudeOauthUsage(body)).toEqual([
      { durationMins: 300, usedPercent: 100, resetsAtMs: null },
      { durationMins: 10_080, usedPercent: 0, resetsAtMs: null },
    ]);
  });
});

describe("Claude OAuth credentials file", () => {
  it("reads the access token, expiry and plan from claudeAiOauth", () => {
    const json = JSON.stringify({
      claudeAiOauth: {
        accessToken: "sk-ant-oat-redacted-test-token",
        refreshToken: "sk-ant-ort-redacted-test-token",
        expiresAt: 1_790_000_000_000,
        subscriptionType: "max",
        rateLimitTier: "default_claude_max_20x",
      },
    });

    expect(parseClaudeCredentials(json)).toEqual({
      accessToken: "sk-ant-oat-redacted-test-token",
      expiresAtMs: 1_790_000_000_000,
      subscriptionType: "max",
    });
  });

  it("returns null when the file is malformed or has no OAuth section", () => {
    expect(parseClaudeCredentials("not json")).toBeNull();
    expect(parseClaudeCredentials(JSON.stringify({ mcpOAuth: {} }))).toBeNull();
    expect(
      parseClaudeCredentials(JSON.stringify({ claudeAiOauth: { accessToken: "" } })),
    ).toBeNull();
  });
});

const TOKEN = "sk-ant-oat-redacted-test-token";
const HOME = "C:\\Users\\tester";
const USAGE_BODY = JSON.stringify({
  five_hour: { utilization: 0.41, resets_at: 1_790_000_000 },
  seven_day: { utilization: 0.17, resets_at: 1_790_300_000 },
});

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
        const url = argv[argv.length - 1] ?? "";
        const result = respond(url);
        return { code: result.code ?? 0, stdout: result.stdout, stderr: result.stderr ?? "" };
      },
    },
  } as unknown as PluginContext;
}

function credentialsFile(expiresAtMs: number, subscriptionType: string): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: TOKEN,
      refreshToken: "sk-ant-ort-redacted-test-token",
      expiresAt: expiresAtMs,
      subscriptionType,
      rateLimitTier: "default_claude_max_20x",
    },
  });
}

describe("readClaudeOauthUsage", () => {
  it("queries the internal usage endpoint with the OAuth bearer token", async () => {
    const calls: ExecCall[] = [];
    const ctx = makeCtx(calls, (url) => {
      if (url.includes(".claude/.credentials.json")) {
        return { stdout: credentialsFile(Date.now() + 3_600_000, "max") };
      }
      if (url.startsWith("https://api.anthropic.com/api/oauth/usage")) {
        return { stdout: `${USAGE_BODY}\n__HTTP_STATUS__200` };
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await readClaudeOauthUsage(ctx, HOME);

    expect(result.error).toBeNull();
    expect(result.planType).toBe("max");
    expect(result.windows).toEqual([
      { durationMins: 300, usedPercent: 41, resetsAtMs: 1_790_000_000_000 },
      { durationMins: 10_080, usedPercent: 17, resetsAtMs: 1_790_300_000_000 },
    ]);

    const http = calls.find((call) => call.args.some((arg) => arg.startsWith("https://")));
    expect(http?.bin).toBe("curl");
    const args = http?.args.join(" ") ?? "";
    expect(args).toContain(`Authorization: Bearer ${TOKEN}`);
    expect(args).toContain("oauth-2025-04-20");
    expect(args).toContain("api/oauth/usage");
  });

  it("reports an expired login without calling the usage endpoint", async () => {
    const calls: ExecCall[] = [];
    const ctx = makeCtx(calls, (url) => {
      if (url.includes(".claude/.credentials.json")) {
        return { stdout: credentialsFile(Date.now() - 60_000, "pro") };
      }
      throw new Error(`unexpected url ${url}`);
    });

    const result = await readClaudeOauthUsage(ctx, HOME);

    expect(result.error).toBe("expired");
    expect(result.windows).toBeNull();
    expect(calls.some((call) => call.args.some((arg) => arg.startsWith("https://")))).toBe(false);
  });

  it("maps 401 to an unauthorized error and never echoes the token", async () => {
    const calls: ExecCall[] = [];
    const ctx = makeCtx(calls, (url) => {
      if (url.includes(".claude/.credentials.json")) {
        return { stdout: credentialsFile(Date.now() + 3_600_000, "max") };
      }
      return { stdout: `{"error":"unauthorized"}\n__HTTP_STATUS__401` };
    });

    const result = await readClaudeOauthUsage(ctx, HOME);

    expect(result.error).toBe("unauthorized");
    expect(result.windows).toBeNull();
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("treats a missing credentials file as no subscription login", async () => {
    const calls: ExecCall[] = [];
    const ctx = makeCtx(calls, () => ({ stdout: "", code: 0 }));

    const result = await readClaudeOauthUsage(ctx, HOME);

    expect(result.error).toBe("missing");
    expect(calls.some((call) => call.args.some((arg) => arg.startsWith("https://")))).toBe(false);
  });
});
