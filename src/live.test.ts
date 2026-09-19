/**
 * 集成验证（默认跳过；`CCGUI_LIVE=1 pnpm test` 时执行）：
 * 用假 PluginContext 把 bridge.invoke 接到真实子进程（cmd / curl），
 * 走与宿主内完全相同的 routes / providers / state 代码路径。
 *
 * 报告写到 %TEMP%\ccgui-plugin\balance-meter\logs\live-report.json
 * （**凭证字段已脱敏**，不落任何密钥）。
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { PluginContext } from "./ccgui-plugin";
import { copy } from "./i18n";
import { BalanceStore } from "./state";

const live = process.env.CCGUI_LIVE === "1";

function makeCtx(): PluginContext {
  const kv = new Map<string, unknown>();
  return {
    pluginId: "balance-meter",
    version: "0.1.0",
    host: { appVersion: "1.0.5", sdkVersion: "0.3.11", locale: "zh-CN", isWeb: false },
    storage: {
      async get<T>(key: string): Promise<T | null> {
        return (kv.get(key) as T) ?? null;
      },
      async set(key: string, value: unknown): Promise<void> {
        kv.set(key, value);
      },
      async delete(key: string): Promise<void> {
        kv.delete(key);
      },
    },
    bridge: {
      async invoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
        if (command !== "plugin_exec_run") throw new Error(`unexpected bridge command ${command}`);
        const bin = String(args?.bin ?? "");
        const argv = (args?.args as string[] | undefined) ?? [];
        const timeoutMs = Number(args?.timeoutMs ?? 20000);
        const result = spawnSync(bin, argv, {
          encoding: "utf8",
          timeout: timeoutMs,
          windowsHide: true,
        });
        if (result.error) throw result.error;
        return {
          code: result.status ?? -1,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
        };
      },
    },
  } as unknown as PluginContext;
}

describe.skipIf(!live)("live", () => {
  it("resolves real routes and queries the active balance", async () => {
    const store = new BalanceStore(makeCtx(), copy("zh-CN"));
    await store.init();
    const state = store.getSnapshot();

    const report = {
      ready: state.ready,
      home: state.home,
      execOk: state.execOk,
      diagnostics: state.diagnostics,
      routes: state.routes.map((route) => ({
        engine: route.engine,
        gateway: route.gateway,
        routeKey: route.routeKey,
        hasCredential: Boolean(route.credential),
        credentialSource: route.credentialSource,
        source: route.source,
      })),
      currentRouteKey: state.currentRoute?.routeKey ?? null,
      snapshot: state.snapshot,
      snapshots: state.snapshots,
    };

    const outDir = path.join(process.env.TEMP ?? ".", "ccgui-plugin", "balance-meter", "logs");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, "live-report.json"),
      JSON.stringify(report, null, 2),
      "utf8",
    );

    expect(state.ready).toBe(true);
    expect(state.routes.length).toBeGreaterThan(0);
  }, 120_000);
});
