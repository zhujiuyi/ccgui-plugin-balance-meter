import { describe, expect, it } from "vitest";

import { helpDocument, parseHelpMarkdown } from "./help";

describe("settings help content", () => {
  it("parses the standalone Markdown format", () => {
    expect(parseHelpMarkdown("# 标题\n\n简介\n\n## 小节\n\n- 条目")).toEqual({
      title: "标题",
      intro: "简介",
      sections: [{ title: "小节", items: ["条目"] }],
    });
  });

  it("lists the currently confirmed subscription channels", () => {
    const text = JSON.stringify(helpDocument("zh-CN"));
    // 面向使用者的说明：只讲"能查到什么、怎么用"，不出现端点路径、本机文件路径
    // 或 Markdown 加粗标记（解析器不支持加粗，会原样显示星号）。
    expect(text).toContain("OpenCode Go");
    expect(text).toContain("Claude 订阅");
    expect(text).toContain("Kimi");
    expect(text).toContain("智谱");
    expect(text).toContain("MiniMax");
    expect(text).toContain("Grok");
  });

  it("parses every section with at least one item", () => {
    // 解析器只认标题/小节/列表项：小节里的普通段落会被静默丢弃。
    // 这条守卫防止"写了段落但界面上看不见"的返工。
    for (const locale of ["zh-CN", "en"]) {
      const doc = helpDocument(locale);
      expect(doc.title.length).toBeGreaterThan(0);
      expect(doc.intro.length).toBeGreaterThan(0);
      expect(doc.sections.length).toBeGreaterThanOrEqual(5);
      for (const section of doc.sections) {
        expect(section.title.length).toBeGreaterThan(0);
        expect(section.items.length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps implementation details out of the user-facing copy", () => {
    for (const locale of ["zh-CN", "en"]) {
      const text = JSON.stringify(helpDocument(locale));
      expect(text).not.toContain("**");
      expect(text).not.toContain("api/oauth/usage");
      expect(text).not.toContain("/coding/v1/usages");
      expect(text).not.toContain("account/rateLimits/read");
      expect(text).not.toContain("/api/monitor/usage/quota/limit");
      expect(text).not.toContain("coding_plan/remains");
      expect(text).not.toContain("~/.kimi-code");
      expect(text).not.toContain("~/.grok");
      expect(text).not.toContain("~/.claude");
      expect(text).not.toContain("~/.codex");
      expect(text).not.toContain("base_url");
    }
  });
});
