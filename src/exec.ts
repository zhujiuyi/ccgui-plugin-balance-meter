/**
 * 出口能力封装：宿主的 `plugin_http_request` 只放行**预声明域名**，而本插件
 * 要按"实际路由"动态访问任意供应商域名，因此统一走 `plugin_exec_run`：
 *   - curl：HTTP 查询（以及 file:// 读本地配置）
 *   - cmd（Windows）/ sh（macOS、Linux）：展开环境变量，定位用户目录
 * 在 manifest 里以 `exec:curl` / `exec:cmd` / `exec:sh` 声明，均为只读用途。
 */

import type { PluginContext } from "./ccgui-plugin";

export type Platform = "windows" | "posix";

let platformOverride: Platform | null = null;

/** 仅供测试注入平台（真机走 navigator 探测）。 */
export function setPlatformOverride(platform: Platform | null): void {
  platformOverride = platform;
}

/** 从 UA 字符串判断平台（纯函数，便于测试）。 */
export function platformFromUserAgent(value: string | null | undefined): Platform {
  const raw = (value ?? "").toLowerCase();
  if (raw.includes("win")) return "windows";
  if (raw.includes("mac") || raw.includes("linux") || raw.includes("x11") || raw.includes("bsd")) {
    return "posix";
  }
  // 判不出来时按已实测的 Windows 路径走，避免"两边都猜错"。
  return "windows";
}

/** 当前运行平台。插件跑在宿主 webview 里，可直接读 navigator。 */
export function detectPlatform(): Platform {
  if (platformOverride) return platformOverride;
  try {
    const nav = (globalThis as { navigator?: Navigator }).navigator;
    const uaData = (nav as unknown as { userAgentData?: { platform?: string } } | undefined)
      ?.userAgentData;
    const raw = uaData?.platform ?? nav?.userAgent ?? nav?.platform ?? "";
    return platformFromUserAgent(raw);
  } catch {
    return "windows";
  }
}

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export async function exec(
  ctx: PluginContext,
  bin: string,
  args: string[],
  timeoutMs = 20000,
): Promise<ExecResult> {
  try {
    const result = await ctx.bridge.invoke<ExecResult>("plugin_exec_run", {
      bin,
      args,
      timeoutMs,
    });
    return {
      code: result?.code ?? null,
      stdout: result?.stdout ?? "",
      stderr: result?.stderr ?? "",
    };
  } catch (error) {
    return { code: null, stdout: "", stderr: String(error) };
  }
}

/**
 * 取用户目录：Windows 走 `cmd /d /c echo %USERPROFILE%`，
 * macOS / Linux 走 `sh -c 'printf %s "$HOME"'`（失败返回 null）。
 */
export async function detectHome(
  ctx: PluginContext,
  platform: Platform = detectPlatform(),
): Promise<string | null> {
  const result =
    platform === "windows"
      ? await exec(ctx, "cmd", ["/d", "/c", "echo %USERPROFILE%"], 5000)
      : await exec(ctx, "sh", ["-c", 'printf %s "$HOME"'], 5000);
  const line = (result.stdout || "").trim().replace(/^"|"$/g, "");
  if (platform === "windows") {
    return /^[A-Za-z]:[\\/]/.test(line) ? line.replace(/[\\/]+$/, "") : null;
  }
  return /^\//.test(line) ? line.replace(/\/+$/, "") : null;
}

/** 读本地文本文件（curl file://，不做任何 shell 解析）。 */
export async function readLocalFile(
  ctx: PluginContext,
  absPath: string,
): Promise<string | null> {
  const url = `file:///${absPath.replace(/\\/g, "/").replace(/^\/+/, "")}`;
  const result = await exec(ctx, "curl", ["-s", "--max-time", "10", url], 12000);
  if (result.code !== 0 || !result.stdout) return null;
  return result.stdout;
}

export interface HttpResult {
  status: number;
  body: string;
}

/** 只读 GET：把状态码附在正文末尾解析（curl -w）。 */
export async function httpGet(
  ctx: PluginContext,
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 15000,
): Promise<HttpResult> {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const args = ["-s", "-S", "-L", "--max-time", String(seconds)];
  for (const [name, value] of Object.entries(headers)) args.push("-H", `${name}: ${value}`);
  args.push("-o", "-", "-w", "\n__HTTP_STATUS__%{http_code}", url);
  const result = await exec(ctx, "curl", args, timeoutMs + 5000);
  const raw = result.stdout ?? "";
  const marker = raw.lastIndexOf("__HTTP_STATUS__");
  if (marker < 0) return { status: 0, body: result.stderr || raw };
  const status = Number.parseInt(raw.slice(marker + "__HTTP_STATUS__".length).trim(), 10) || 0;
  return { status, body: raw.slice(0, marker).trim() };
}
