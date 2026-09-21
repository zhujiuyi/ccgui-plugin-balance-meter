import { describe, expect, it } from "vitest";

import { codexRateLimitsCommand, parseCodexRateLimits } from "./codex";

describe("Codex App Server rate limits", () => {
  it("parses the official multi-window response", () => {
    const stdout = [
      JSON.stringify({ id: 0, result: { userAgent: "test" } }),
      JSON.stringify({
        id: 6,
        result: {
          rateLimits: {
            primary: { usedPercent: 46, windowDurationMins: 300, resetsAt: 1_790_000_000 },
            secondary: { usedPercent: 57, windowDurationMins: 10_080, resetsAt: 1_790_300_000 },
            planType: "plus",
          },
          rateLimitsByLimitId: {
            codex: {
              primary: { usedPercent: 46, windowDurationMins: 300, resetsAt: 1_790_000_000 },
              secondary: { usedPercent: 57, windowDurationMins: 10_080, resetsAt: 1_790_300_000 },
              planType: "plus",
            },
          },
        },
      }),
    ].join("\n");

    const parsed = parseCodexRateLimits(stdout);
    expect(parsed?.primary.usedPercent).toBe(46);
    expect(parsed?.secondary?.windowDurationMins).toBe(10_080);
    expect(parsed?.planType).toBe("plus");
  });

  it("builds a shell pipeline without placing account credentials on the command line", () => {
    const windows = codexRateLimitsCommand("windows");
    const posix = codexRateLimitsCommand("posix");
    expect(windows.bin).toBe("powershell.exe");
    expect(windows.args).toContain("-EncodedCommand");
    expect(posix.bin).toBe("sh");
    expect(posix.args.join(" ")).toContain("codex app-server");
    expect(JSON.stringify([windows, posix])).not.toContain("access_token");
  });
});
