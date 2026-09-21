import helpEn from "./content/help.en.md?raw";
import helpZhCn from "./content/help.zh-CN.md?raw";

export interface HelpSection {
  title: string;
  items: string[];
}

export interface HelpDocument {
  title: string;
  intro: string;
  sections: HelpSection[];
}

/**
 * 解析本插件约定的简化 Markdown：一级标题、简介、二级标题和无序列表。
 * 内容与渲染代码分离，后续更新供应商清单只需编辑 content/*.md。
 */
export function parseHelpMarkdown(source: string): HelpDocument {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let title = "";
  const intro: string[] = [];
  const sections: HelpSection[] = [];
  let current: HelpSection | null = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("# ")) {
      title = line.slice(2).trim();
      continue;
    }
    if (line.startsWith("## ")) {
      current = { title: line.slice(3).trim(), items: [] };
      sections.push(current);
      continue;
    }
    if (line.startsWith("- ") && current) {
      current.items.push(line.slice(2).trim());
      continue;
    }
    if (!current) intro.push(line);
  }

  return { title, intro: intro.join(" "), sections };
}

const ZH = parseHelpMarkdown(helpZhCn);
const EN = parseHelpMarkdown(helpEn);

export function helpDocument(locale: string): HelpDocument {
  return locale?.toLowerCase().startsWith("zh") ? ZH : EN;
}
