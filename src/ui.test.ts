import { describe, expect, it, vi } from "vitest";

import { isOutsideElement } from "./ui";

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
