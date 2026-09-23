/**
 * UI 组件（状态栏 chip + 液态玻璃面板 + 设置页 section）。
 *
 * 两条纪律：
 *  1. 只用 `ctx.react` 的 createElement 与 hooks（宿主 React 树内渲染），不 import 三方包。
 *  2. **组件必须是模块级稳定引用**——绝不在 render 里现造组件函数。宿主的状态栏会在
 *     hover 等场景重渲染插件 UI；若组件身份每次都变，React 会卸载重挂子树，局部 state
 *     （例如"正在编辑查询地址"）会被重置，表现为输入框自动消失。
 *     因此编辑态统一放在 store（state.edit），组件身份与路由无关（route 走 props）。
 */

import type { PluginContext } from "./ccgui-plugin";
import type { Copy } from "./i18n";
import { helpDocument } from "./help";
import type { RouteInfo } from "./routes";
import { formatAmount, type BalanceStore, type MeterState } from "./state";

type React = PluginContext["react"];

/** 仅用于判定状态栏插件根节点之外的交互，保持逻辑可单测。 */
export function isOutsideElement(
  root: Pick<Node, "contains"> | null,
  target: EventTarget | null,
): boolean {
  return Boolean(root && target && !root.contains(target as Node));
}

// lucide（ISC）图标 path 数据内联，避免运行时依赖。
const WALLET_PATHS = [
  "M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1",
  "M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4",
];
const REFRESH_PATHS = ["M21 12a9 9 0 1 1-2.64-6.36", "M21 3v6h-6"];
const PENCIL_PATHS = ["M12 20h9", "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"];
const CLOSE_PATHS = ["M18 6 6 18", "m6 6 12 12"];

function icon(react: React, paths: string[], size = 16) {
  return react.createElement(
    "svg",
    {
      viewBox: "0 0 24 24",
      width: size,
      height: size,
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": true,
    },
    paths.map((d) => react.createElement("path", { key: d, d })),
  );
}

function billingLabel(t: Copy, billing: string): string {
  if (billing === "api") return t.billingApi;
  if (billing === "subscription") return t.billingSubscription;
  return t.billingUnknown;
}

function timeLabel(ts: number | null | undefined): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return "—";
  }
}

function quotaWindows(react: React, t: Copy, snapshot: NonNullable<MeterState["snapshot"]>) {
  const names = {
    rolling: t.quotaRolling,
    weekly: t.quotaWeekly,
    monthly: t.quotaMonthly,
    duration: "",
  };
  return react.createElement(
    "div",
    { className: "balance-meter-quota-windows" },
    snapshot.quotaWindows?.map((window) =>
      react.createElement(
        "div",
        // 同一行可能有多个 duration 窗口（如 5 小时 + 7 天），key 必须带时长，
        // 否则 React 视为重复 key、可能复用错节点。
        { className: "balance-meter-quota-window", key: `${window.kind}:${window.durationMins ?? ""}` },
        react.createElement(
          "span",
          { className: "balance-meter-quota-value" },
          `${window.kind === "duration" && window.durationMins
            ? t.quotaDuration(window.durationMins)
            : names[window.kind]} ${Math.round(window.remaining)}%`,
        ),
        window.resetAt &&
          react.createElement(
            "span",
            { className: "balance-meter-quota-reset" },
            t.quotaResetAt(window.resetAt),
          ),
      ),
    ),
  );
}

/** 概览行：引擎 / 供应商 / 计费方式 / 当前余量 / 最近查询。 */
function summaryRows(react: React, t: Copy, state: MeterState, route: RouteInfo | null) {
  const snapshot = state.snapshot;
  const entries: Array<[string, string | ReturnType<React["createElement"]>]> = [];
  if (route) {
    entries.push([
      t.settingsEngine,
      state.engineConfirmed ? route.engine : `${route.engine}（${t.engineUnconfirmed}）`,
    ]);
  }
  entries.push(
    [t.rowProvider, snapshot?.providerName ?? "—"],
    [t.rowBilling, billingLabel(t, snapshot?.billing ?? "unknown")],
    [
      t.rowAmount,
      snapshot && snapshot.kind !== "unavailable" ? formatAmount(snapshot) : t.unavailable,
    ],
  );
  if (snapshot?.planName) entries.push([t.rowPlan, snapshot.planName]);
  if (snapshot?.quotaWindows?.length) entries.push([t.rowDetails, quotaWindows(react, t, snapshot)]);
  else if (snapshot?.detail) entries.push([t.rowBalanceDetail, snapshot.detail]);
  entries.push([t.rowCheckedAt, snapshot ? timeLabel(snapshot.checkedAt) : t.neverChecked]);
  return react.createElement(
    "dl",
    { className: "balance-meter-dl" },
    entries.map(([label, value]) =>
      react.createElement(
        "div",
        {
          className: `balance-meter-row${label === t.rowDetails ? " is-details" : ""}`,
          key: label,
        },
        react.createElement("dt", null, label),
        react.createElement("dd", { title: typeof value === "string" ? value : undefined }, value),
      ),
    ),
  );
}

interface EndpointBlockProps {
  ctx: PluginContext;
  store: BalanceStore;
  t: Copy;
  route: RouteInfo;
}

/**
 * 查询地址区块（模块级组件 → 身份稳定）。点「修改」进入编辑态，状态存在 store 上，
 * 宿主重渲染不会丢；点「保存」写入该路由并立即重查。
 */
function EndpointBlock(props: EndpointBlockProps) {
  const { ctx, store, t, route } = props;
  const react = ctx.react;
  const state = react.useSyncExternalStore(store.subscribe, store.getSnapshot);
  const edit = state.edit && state.edit.routeKey === route.routeKey ? state.edit : null;
  const override = state.endpointOverrides[route.routeKey] ?? "";
  const snapshot = state.snapshots[route.routeKey] ?? state.snapshot;
  const current = override || snapshot?.endpoint || "";
  const customised = Boolean(override) || snapshot?.endpointSource === "custom";

  const header = react.createElement(
    "div",
    { className: "balance-meter-endpoint-head" },
    react.createElement("span", { className: "balance-meter-endpoint-label" }, t.endpointTitle),
    react.createElement(
      "span",
      { className: `balance-meter-tag${customised ? " is-custom" : ""}` },
      customised ? t.overridden : t.autoDetect,
    ),
    !edit &&
      react.createElement(
        "button",
        {
          type: "button",
          className: "balance-meter-ghost-btn",
          onClick: () => store.beginEndpointEdit(route.routeKey, override || snapshot?.endpoint || ""),
        },
        icon(react, PENCIL_PATHS, 12),
        react.createElement("span", null, t.edit),
      ),
    !edit &&
      override &&
      react.createElement(
        "button",
        {
          type: "button",
          className: "balance-meter-ghost-btn",
          onClick: () => {
            void store.saveEndpointOverride(route.routeKey, "");
          },
        },
        react.createElement("span", null, t.resetAuto),
      ),
  );

  if (!edit) {
    return react.createElement(
      "div",
      { className: "balance-meter-endpoint" },
      header,
      react.createElement(
        "code",
        { className: "balance-meter-endpoint-value", title: current },
        current || t.autoDetect,
      ),
    );
  }

  return react.createElement(
    "div",
    { className: "balance-meter-endpoint is-editing" },
    header,
    react.createElement(
      "div",
      { className: "balance-meter-edit-row" },
      react.createElement("input", {
        className: "balance-meter-input",
        type: "text",
        spellCheck: false,
        value: edit.draft,
        placeholder: t.endpointPlaceholder,
        autoFocus: true,
        onChange: (event: { target: { value: string } }) =>
          store.updateEndpointDraft(event.target.value),
        onKeyDown: (event: { key: string; preventDefault: () => void }) => {
          if (event.key === "Enter") {
            event.preventDefault();
            void store.commitEndpointEdit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            store.cancelEndpointEdit();
          }
        },
      }),
      react.createElement(
        "div",
        { className: "balance-meter-edit-actions" },
        react.createElement(
          "button",
          {
            type: "button",
            className: "balance-meter-primary-btn is-grow",
            disabled: edit.saving,
            onClick: () => void store.commitEndpointEdit(),
          },
          edit.saving ? t.saving : t.save,
        ),
        react.createElement(
          "button",
          {
            type: "button",
            className: "balance-meter-ghost-btn",
            disabled: edit.saving,
            onClick: () => store.cancelEndpointEdit(),
          },
          t.cancel,
        ),
      ),
    ),
    edit.error && react.createElement("p", { className: "balance-meter-error" }, edit.error),
  );
}

interface RefreshButtonProps {
  ctx: PluginContext;
  store: BalanceStore;
  t: Copy;
  refreshing: boolean;
  label: string;
  block?: boolean;
}

/** 设置页底部的使用说明：工作原理 / 更新时机 / 缓存 / 数据与权限。 */
function HelpCard({ ctx, t }: { ctx: PluginContext; t: Copy }) {
  const react = ctx.react;
  const help = helpDocument(ctx.host.locale);
  const block = (title: string, items: string[]) =>
    react.createElement(
      "div",
      { className: "balance-meter-help-block", key: title },
      react.createElement("p", { className: "balance-meter-help-title" }, title),
      react.createElement(
        "ul",
        { className: "balance-meter-help-list" },
        items.map((item) => react.createElement("li", { key: item }, item)),
      ),
    );

  return react.createElement(
    "div",
    { className: "balance-meter-card" },
    react.createElement("p", { className: "balance-meter-panel-title" }, help.title),
    react.createElement("p", { className: "balance-meter-help-intro" }, help.intro),
    ...help.sections.map((section) => block(section.title, section.items)),
  );
}

function RefreshButton(props: RefreshButtonProps) {
  const { ctx, store, t, refreshing, label, block } = props;
  return ctx.react.createElement(
    "button",
    {
      type: "button",
      className: `balance-meter-primary-btn${block ? " is-block" : ""}`,
      disabled: refreshing,
      onClick: () => {
        void store.refresh("manual");
      },
    },
    icon(ctx.react, REFRESH_PATHS, 14),
    ctx.react.createElement("span", null, refreshing ? t.refreshing : label),
  );
}

/** 状态栏 chip：余额 + 点击展开玻璃面板（详情 / 改地址 / 手动刷新）。 */
export function makeChip(ctx: PluginContext, store: BalanceStore, t: Copy) {
  return function BalanceChip() {
    const react = ctx.react;
    const state = react.useSyncExternalStore(store.subscribe, store.getSnapshot);
    const open = state.panelOpen;
    const rootRef = react.useRef<HTMLSpanElement>(null);
    react.useEffect(() => {
      if (!open) return;
      const closeOnOutsidePointer = (event: PointerEvent) => {
        if (isOutsideElement(rootRef.current, event.target)) store.closePanel();
      };
      document.addEventListener("pointerdown", closeOnOutsidePointer, true);
      return () => document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
    }, [open]);
    const snapshot = state.snapshot;
    const route = state.currentRoute;
    const text = !snapshot
      ? t.chipUnknown
      : snapshot.kind === "unavailable"
        ? t.chipUnavailable
        : formatAmount(snapshot);
    const tooltip =
      snapshot && snapshot.kind !== "unavailable"
        ? `${snapshot.providerName} · ${billingLabel(t, snapshot.billing)} · ${timeLabel(snapshot.checkedAt)}`
        : `${t.unavailable}${snapshot?.error ? `（${snapshot.error}）` : ""}`;

    const button = react.createElement(
      "button",
      {
        type: "button",
        className: `balance-meter-chip${open ? " is-open" : ""}`,
        "aria-label": t.chipAria,
        title: tooltip,
        onClick: (event: { stopPropagation: () => void }) => {
          event.stopPropagation();
          store.togglePanel();
        },
      },
      icon(react, WALLET_PATHS, 15),
      react.createElement("span", null, text),
    );

    if (!open) {
      return react.createElement("span", { className: "balance-meter-wrap", ref: rootRef }, button);
    }

    const panel = react.createElement(
      "div",
      { className: "balance-meter-panel", role: "dialog" },
      react.createElement(
        "div",
        { className: "balance-meter-panel-head" },
        react.createElement("p", { className: "balance-meter-panel-title" }, t.panelTitle),
        react.createElement(
          "button",
          {
            type: "button",
            className: "balance-meter-close-btn",
            "aria-label": t.close,
            title: t.close,
            onClick: () => store.togglePanel(),
          },
          icon(react, CLOSE_PATHS, 14),
        ),
      ),
      summaryRows(react, t, state, route),
      react.createElement("div", { className: "balance-meter-divider" }),
      route
        ? react.createElement(EndpointBlock, {
            key: route.routeKey,
            ctx,
            store,
            t,
            route,
          })
        : react.createElement("p", { className: "balance-meter-note" }, t.settingsEmpty),
      snapshot?.kind === "unavailable" && snapshot.error
        ? react.createElement(
            "p",
            { className: "balance-meter-note" },
            `${t.unavailable}：${snapshot.error}`,
          )
        : null,
      react.createElement("div", { className: "balance-meter-divider" }),
      react.createElement(RefreshButton, {
        ctx,
        store,
        t,
        refreshing: state.refreshing,
        label: t.refresh,
        block: true,
      }),
    );

    return react.createElement(
      "span",
      { className: "balance-meter-wrap", ref: rootRef },
      button,
      panel,
    );
  };
}

/** 设置页 section：当前路由详情 + 改地址 + 全部刷新 + 路由表 + 诊断。 */
export function makeSettingsSection(ctx: PluginContext, store: BalanceStore, t: Copy) {
  return function BalanceSettings() {
    const react = ctx.react;
    const state = react.useSyncExternalStore(store.subscribe, store.getSnapshot);
    const route = state.currentRoute;
    const snapshot = state.snapshot;

    const routeRows = state.routes.map((item) => {
      const routeSnapshot = state.snapshots[item.routeKey] ?? null;
      const value =
        routeSnapshot && routeSnapshot.kind !== "unavailable"
          ? formatAmount(routeSnapshot)
          : t.unavailable;
      return react.createElement(
        "tr",
        { key: item.routeKey },
        react.createElement("td", null, item.engine),
        react.createElement("td", { title: item.gateway }, item.routeKey),
        react.createElement("td", { title: routeSnapshot?.providerName ?? "" }, value),
        react.createElement(
          "td",
          { title: item.credentialSource },
          item.credential ? t.ok : t.missing,
        ),
      );
    });

    return react.createElement(
      "div",
      { className: "balance-meter-settings" },
      react.createElement("p", { className: "balance-meter-intro" }, t.settingsIntro),

      react.createElement(
        "div",
        { className: "balance-meter-card" },
        react.createElement("p", { className: "balance-meter-panel-title" }, t.panelTitle),
        summaryRows(react, t, state, route),
        route
          ? react.createElement(
              react.Fragment,
              null,
              react.createElement("div", { className: "balance-meter-divider" }),
              react.createElement(EndpointBlock, { key: route.routeKey, ctx, store, t, route }),
            )
          : null,
        snapshot?.kind === "unavailable" && snapshot.error
          ? react.createElement(
              "p",
              { className: "balance-meter-note" },
              `${t.unavailable}：${snapshot.error}`,
            )
          : null,
      ),

      react.createElement(
        "div",
        { className: "balance-meter-actions" },
        react.createElement(RefreshButton, {
          ctx,
          store,
          t,
          refreshing: state.refreshing,
          label: t.refreshAll,
        }),
      ),

      react.createElement("p", { className: "balance-meter-panel-title" }, t.settingsRoutes),
      routeRows.length
        ? react.createElement(
            "table",
            { className: "balance-meter-table" },
            react.createElement(
              "thead",
              null,
              react.createElement(
                "tr",
                null,
                react.createElement("th", null, t.settingsEngine),
                react.createElement("th", null, t.settingsGateway),
                react.createElement("th", null, t.rowAmount),
                react.createElement("th", null, t.settingsKeySource),
              ),
            ),
            react.createElement("tbody", null, routeRows),
          )
        : react.createElement("p", { className: "balance-meter-note" }, t.settingsEmpty),

      react.createElement("p", { className: "balance-meter-panel-title" }, t.settingsDiagnostics),
      react.createElement(
        "ul",
        { className: "balance-meter-note" },
        react.createElement("li", null, `${t.settingsHome}: ${state.home ?? "—"}`),
        react.createElement("li", null, `${t.settingsExecShell}: ${state.execOk.shell ? t.ok : t.missing}`),
        react.createElement("li", null, `${t.settingsExecCurl}: ${state.execOk.curl ? t.ok : t.missing}`),
        ...state.diagnostics.map((line) => react.createElement("li", { key: line }, line)),
      ),

      react.createElement(HelpCard, { ctx, t }),
    );
  };
}
