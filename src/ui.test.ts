import { describe, expect, it, vi } from "vitest";

import { copy } from "./i18n";
import type { BalanceSnapshot } from "./state";
import { chipLabel, isOutsideElement, summaryRows } from "./ui";

describe("status panel outside interaction", () => {
  it("distinguishes panel descendants from outside targets", () => {
    const inside = new EventTarget();
    const outside = new EventTarget();
    const contains = vi.fn((target: Node) => target === (inside as unknown as Node));
    const root = { contains };

    expect(isOutsideElement(root, inside)).toBe(false);
    expect(isOutsideElement(root, outside)).toBe(true);
    expect(isOutsideElement(null, outside)).toBe(false);
  });
});

function subscriptionSnapshot(): BalanceSnapshot {
  return {
    kind: "subscription",
    providerId: "opendesign",
    providerName: "Open Design",
    billing: "subscription",
    currency: "%",
    amount: 98.3,
    total: 100,
    used: 1.7,
    planName: "Open Design Go",
    detail: null,
    quotaWindows: [
      { kind: "duration", durationMins: 300, used: 1.7, remaining: 98.3, resetAt: null },
      { kind: "weekly", used: 6.2, remaining: 93.8, resetAt: null },
    ],
    endpoint: "https://example.test/quota",
    endpointLabel: "quota",
    endpointSource: "auto",
    checkedAt: 0,
    error: null,
  };
}

describe("status chip label", () => {
  it("names the shortest quota window so the number has context", () => {
    // 订阅场景的 chip 数字来自「最容易撞到的天花板」（5 小时窗口），
    // 只显示 98% 会让人误以为这是整个订阅周期的余量。
    expect(chipLabel(subscriptionSnapshot(), copy("zh-CN"))).toBe("5小时 98%");
    expect(chipLabel(subscriptionSnapshot(), copy("en"))).toBe("5h 98%");
  });

  it("keeps plain amounts for balance channels and the unavailable states", () => {
    const balance = {
      ...subscriptionSnapshot(),
      kind: "balance" as const,
      billing: "api" as const,
      currency: "USD",
      amount: 1.5,
      quotaWindows: null,
    };
    expect(chipLabel(balance, copy("zh-CN"))).toBe("$1.50");
    expect(chipLabel(null, copy("zh-CN"))).toBe("—");
    expect(
      chipLabel({ ...subscriptionSnapshot(), kind: "unavailable" }, copy("zh-CN")),
    ).toBe("无法查询");
  });
});

describe("panel summary rows", () => {
  const fakeReact = {
    createElement: (type: string, props: Record<string, unknown> | null, ...children: unknown[]) => ({
      type,
      props,
      children,
    }),
  };

  interface Node {
    type?: string;
    props?: Record<string, unknown> | null;
    children?: unknown[];
  }

  function dtLabels(node: unknown, out: string[] = []): string[] {
    if (Array.isArray(node)) {
      for (const child of node) dtLabels(child, out);
      return out;
    }
    if (!node || typeof node !== "object") return out;
    const element = node as Node;
    if (element.type === "dt") {
      const text = element.children?.[0];
      if (typeof text === "string") out.push(text);
    }
    for (const child of element.children ?? []) dtLabels(child, out);
    return out;
  }

  function labels(snapshot: BalanceSnapshot): string[] {
    return dtLabels(summaryRows(fakeReact as never, copy("zh-CN"), { snapshot } as never, null));
  }

  it("omits the duplicated amount row for subscriptions (the windows carry the numbers)", () => {
    const rows = labels(subscriptionSnapshot());
    expect(rows).not.toContain("当前余量");
    expect(rows).toContain("额度窗口");
  });

  it("keeps the amount row for balance channels", () => {
    const rows = labels({
      ...subscriptionSnapshot(),
      kind: "balance",
      billing: "api",
      currency: "USD",
      amount: 1.5,
      quotaWindows: null,
    });
    expect(rows).toContain("当前余量");
  });
});
