import type { PluginContext } from "./ccgui-plugin";
import { detectPlatform, exec } from "./exec";

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number;
  resetsAt: number;
}

export interface CodexRateLimits {
  primary: CodexRateLimitWindow;
  secondary: CodexRateLimitWindow | null;
  planType: string | null;
}

const INITIALIZE = JSON.stringify({
  method: "initialize",
  id: 0,
  params: {
    clientInfo: {
      name: "ccgui_balance_meter",
      title: "CC GUI Balance Meter",
      version: "0.2.0",
    },
  },
});
const INITIALIZED = JSON.stringify({ method: "initialized", params: {} });
const READ_LIMITS = JSON.stringify({ method: "account/rateLimits/read", id: 6 });

function powershellEncodedCommand(script: string): string {
  const bytes = new Uint8Array(script.length * 2);
  for (let index = 0; index < script.length; index += 1) {
    const code = script.charCodeAt(index);
    bytes[index * 2] = code & 0xff;
    bytes[index * 2 + 1] = code >>> 8;
  }
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * `plugin_exec_run` 没有 stdin 参数，因此由系统 shell 给 Codex app-server
 * 写入三条 JSONL。短暂停顿用于等待 initialize 完成，并在读到结果前保持管道打开。
 */
export function codexRateLimitsCommand(platform = detectPlatform()): {
  bin: "powershell.exe" | "sh";
  args: string[];
} {
  if (platform === "windows") {
    const script =
      `$ProgressPreference='SilentlyContinue'; ` +
      `$utf8=New-Object System.Text.UTF8Encoding $false; ` +
      `[Console]::OutputEncoding=$utf8; $OutputEncoding=$utf8; ` +
      `$si=New-Object System.Diagnostics.ProcessStartInfo; ` +
      `$si.FileName='codex'; $si.Arguments='app-server'; $si.UseShellExecute=$false; ` +
      `$si.CreateNoWindow=$true; $si.RedirectStandardInput=$true; ` +
      `$si.RedirectStandardOutput=$true; $si.RedirectStandardError=$true; ` +
      `$p=New-Object System.Diagnostics.Process; $p.StartInfo=$si; [void]$p.Start(); ` +
      `$p.StandardInput.WriteLine('${INITIALIZE}'); $p.StandardInput.Flush(); ` +
      `Start-Sleep -Seconds 1; ` +
      `$p.StandardInput.WriteLine('${INITIALIZED}'); ` +
      `$p.StandardInput.WriteLine('${READ_LIMITS}'); $p.StandardInput.Flush(); ` +
      `Start-Sleep -Seconds 4; $p.StandardInput.Close(); ` +
      `$stdout=$p.StandardOutput.ReadToEnd(); $stderr=$p.StandardError.ReadToEnd(); ` +
      `$p.WaitForExit(); [Console]::Out.Write($stdout); [Console]::Error.Write($stderr)`;
    return {
      bin: "powershell.exe",
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        powershellEncodedCommand(script),
      ],
    };
  }

  const command =
    `{ printf '%s\\n' ${shQuote(INITIALIZE)}; sleep 1; ` +
    `printf '%s\\n' ${shQuote(INITIALIZED)} ${shQuote(READ_LIMITS)}; sleep 5; } ` +
    `| codex app-server`;
  return { bin: "sh", args: ["-c", command] };
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseWindow(value: unknown): CodexRateLimitWindow | null {
  const row = object(value);
  const usedPercent = finite(row?.usedPercent);
  const windowDurationMins = finite(row?.windowDurationMins);
  const resetsAt = finite(row?.resetsAt);
  if (usedPercent === null || windowDurationMins === null || resetsAt === null) return null;
  return { usedPercent, windowDurationMins, resetsAt };
}

export function parseCodexRateLimits(stdout: string): CodexRateLimits | null {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let message: Record<string, unknown> | null = null;
    try {
      message = object(JSON.parse(line));
    } catch {
      continue;
    }
    if (message?.id !== 6) continue;
    const result = object(message.result);
    const byId = object(result?.rateLimitsByLimitId);
    const rateLimits = object(byId?.codex) ?? object(result?.rateLimits);
    const primary = parseWindow(rateLimits?.primary);
    if (!primary) return null;
    const planType = typeof rateLimits?.planType === "string" ? rateLimits.planType : null;
    return {
      primary,
      secondary: parseWindow(rateLimits?.secondary),
      planType,
    };
  }
  return null;
}

export async function readCodexRateLimits(ctx: PluginContext): Promise<{
  limits: CodexRateLimits | null;
  error: string | null;
}> {
  const command = codexRateLimitsCommand();
  const result = await exec(ctx, command.bin, command.args, 15_000);
  const limits = parseCodexRateLimits(result.stdout);
  if (limits) return { limits, error: null };
  const detail = (result.stderr || result.stdout || `exit ${result.code ?? "unknown"}`).trim();
  return {
    limits: null,
    error: detail.slice(0, 500) || "Codex app-server did not return rate limits",
  };
}
