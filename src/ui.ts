/**
 * UI 组件（状态栏 chip + 浮动面板 + 设置页 section）。
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
import {
  formatAmount,
  primaryWindow,
  quotaMetric,
  quotaValue,
  type BalanceSnapshot,
  type BalanceStore,
  type MeterState,
  type QuotaSample,
} from "./state";

type React = PluginContext["react"];
type Window = NonNullable<BalanceSnapshot["quotaWindows"]>[number];

/** 仅用于判定状态栏插件根节点之外的交互，保持逻辑可单测。 */
export function isOutsideElement(
  root: Pick<Node, "contains"> | null,
  target: EventTarget | null,
): boolean {
  return Boolean(root && target && !root.contains(target as Node));
}

// 图标 path 数据内联，避免运行时依赖（lucide，ISC）。
const REFRESH_PATHS = ["M21 12a9 9 0 1 1-2.64-6.36", "M21 3v6h-6"];
const PENCIL_PATHS = ["M12 20h9", "M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"];
const CLOSE_PATHS = ["M18 6 6 18", "m6 6 12 12"];
const CHEVRON_PATHS = ["m6 9 6 6 6-6"];
const WALLET_PATHS = [
  "M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1",
  "M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4",
];

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

/** 订阅窗口的短标签：5 小时 / 7 天 / 每周 / 每月。 */
function shortWindowLabel(t: Copy, window: Window): string {
  if (window.kind === "weekly") return t.quotaWeeklyShort;
  if (window.kind === "monthly") return t.quotaMonthlyShort;
  if (window.kind === "rolling") return t.quotaRolling;
  const mins = window.durationMins ?? 0;
  if (mins >= 1440 && mins % 1440 === 0) return `${mins / 1440}${t.quotaDaysShort}`;
  if (mins >= 60 && mins % 60 === 0) return `${mins / 60}${t.quotaHoursShort}`;
  return `${mins}${t.quotaMinsShort}`;
}

/** 窗口的完整名称（额度窗口行）：5 小时额度 / 每周额度。 */
function windowLabel(t: Copy, window: Window): string {
  if (window.kind === "duration" && window.durationMins) return t.quotaDuration(window.durationMins);
  if (window.kind === "weekly") return t.quotaWeekly;
  if (window.kind === "monthly") return t.quotaMonthly;
  return t.quotaRolling;
}

/** 面板里的日期时间：`10/20 04:14`。 */
function shortDateTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  try {
    const date = new Date(ts);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  } catch {
    return "—";
  }
}

function relativeTime(t: Copy, ts: number | null | undefined, now: number): string {
  if (!ts) return t.neverChecked;
  const minutes = Math.max(0, Math.floor((now - ts) / 60000));
  return minutes === 0 ? t.readJustNow : t.readMinutesAgo(minutes);
}

/**
 * 状态栏 chip 文案（纯文本，供 tooltip / 测试）。
 * 订阅场景显示**最短（最容易撞到）的额度窗口**并带上窗口名。
 */
export function chipLabel(snapshot: BalanceSnapshot | null, t: Copy): string {
  if (!snapshot) return t.chipUnknown;
  if (snapshot.kind === "unavailable") return t.chipUnavailable;
  const primary = primaryWindow(snapshot);
  if (primary) return `${shortWindowLabel(t, primary)} ${Math.round(primary.remaining)}%`;
  return formatAmount(snapshot);
}

/** 状态栏 chip 的两段式文案：`5小时 · 剩` + `93%`（数字加粗着色）。 */
function chipParts(
  snapshot: BalanceSnapshot | null,
  t: Copy,
): { lead: string; value: string } {
  if (!snapshot) return { lead: "", value: t.chipUnknown };
  if (snapshot.kind === "unavailable") return { lead: "", value: t.chipUnavailable };
  const primary = primaryWindow(snapshot);
  if (primary) {
    return {
      lead: `${shortWindowLabel(t, primary)} · ${t.chipRemaining}`,
      value: `${Math.round(primary.remaining)}%`,
    };
  }
  return { lead: "", value: formatAmount(snapshot) };
}

/** 数字滚动：面板打开与刷新后，大数字从 0 缓动到目标值。 */
function useCountUp(react: React, value: number, duration = 1000): number {
  const [display, setDisplay] = react.useState(0);
  react.useEffect(() => {
    // 系统开启「减少动态效果」时直接显示终值（也便于截图与测试）。
    const reduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setDisplay(value);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      // 首帧可能早于 start（rAF 时间戳与 performance.now 同源但可略早），
      // 必须夹到 [0, 1]，否则会闪出一个负值。
      const progress = Math.min(1, Math.max(0, (now - start) / duration));
      const eased = 1 - Math.pow(1 - progress, 4);
      setDisplay(value * eased);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, duration]);
  return display;
}

/** 仪表盘：64 格刻度 + 渐变圆弧，数值是剩余百分比。 */
function Gauge(props: { react: React; value: number }) {
  const { react, value } = props;
  const shown = useCountUp(react, value, 1100);
  const ticks = [];
  const N = 64;
  for (let i = 0; i < N; i++) {
    const angle = (i / N) * Math.PI * 2 - Math.PI / 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    ticks.push(
      react.createElement("line", {
        key: i,
        x1: (60 + cos * 39.6).toFixed(2),
        y1: (60 + sin * 39.6).toFixed(2),
        x2: (60 + cos * 43.6).toFixed(2),
        y2: (60 + sin * 43.6).toFixed(2),
        strokeLinecap: "round",
        className: i / N < value / 100 ? "on" : undefined,
      }),
    );
  }
  return react.createElement(
    "div",
    { className: "balance-meter-gauge", "aria-hidden": true },
    react.createElement(
      "svg",
      { className: "balance-meter-gauge-svg", viewBox: "0 0 120 120" },
      react.createElement(
        "defs",
        null,
        react.createElement(
          "linearGradient",
          { id: "balanceMeterArc", x1: "0%", y1: "0%", x2: "100%", y2: "100%" },
          react.createElement("stop", { offset: "0%", stopColor: "#0a8a6e" }),
          react.createElement("stop", { offset: "100%", stopColor: "#5f8a00" }),
        ),
      ),
      react.createElement("circle", { className: "balance-meter-gauge-track", cx: 60, cy: 60, r: 49 }),
      react.createElement("g", { className: "balance-meter-gauge-ticks" }, ticks),
      react.createElement("circle", {
        className: "balance-meter-gauge-arc",
        key: `${Math.round(value * 10)}`,
        cx: 60,
        cy: 60,
        r: 49,
        pathLength: 100,
        transform: "rotate(-90 60 60)",
        style: { strokeDashoffset: String(100 - value) },
      }),
    ),
    react.createElement(
      "div",
      { className: "balance-meter-gauge-core" },
      react.createElement("span", null, Math.round(shown)),
      react.createElement("span", { className: "balance-meter-gauge-unit" }, "%"),
    ),
    react.createElement("div", { className: "balance-meter-gauge-orbit" }),
  );
}

/** 分段进度条：左侧填充 + 右端标记（对应参考稿的仪表条）。 */
function QuotaBar(props: { react: React; value: number; label: string }) {
  const { react, value, label } = props;
  return react.createElement(
    "div",
    { className: "balance-meter-bar", role: "img", "aria-label": label },
    react.createElement("div", {
      className: "balance-meter-bar-fill",
      key: Math.round(value * 10),
      style: { width: `${value}%` },
    }),
    react.createElement("div", {
      className: "balance-meter-bar-marker",
      style: { left: `${value}%` },
    }),
  );
}

/** 24 小时趋势：取当前窗口的采样点画折线。 */
function Trend(props: {
  react: React;
  t: Copy;
  samples: QuotaSample[];
  metric: string | null;
  title: string;
}) {
  const { react, t, samples, metric, title } = props;
  const points = metric ? samples.filter((sample) => sample.metric === metric) : [];
  if (points.length < 2) {
    return react.createElement(
      "div",
      { className: "balance-meter-trend" },
      react.createElement(
        "div",
        { className: "balance-meter-trend-head" },
        react.createElement("span", { className: "balance-meter-trend-title" }, title),
      ),
      react.createElement("p", { className: "balance-meter-trend-empty" }, t.trendEmpty),
    );
  }
  const values = points.map((point) => point.value);
  const lo = Math.min(...values) - 0.6;
  const hi = Math.max(...values) + 0.6;
  const span = hi - lo || 1;
  const W = 380;
  const H = 64;
  const padX = 4;
  const top = 8;
  const bottom = 8;
  const coords = points.map((point, index) => ({
    x: padX + ((W - padX * 2) * index) / (points.length - 1),
    y: top + (H - top - bottom) * (1 - (point.value - lo) / span),
  }));
  const path = coords
    .map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(" ");
  const first = coords[0];
  const last = coords[coords.length - 1];
  const area = `${path} L ${last.x.toFixed(2)} ${H - bottom} L ${first.x.toFixed(2)} ${H - bottom} Z`;
  const delta = points[points.length - 1].value - points[0].value;
  const deltaText = `${delta >= 0 ? "+" : "−"}${Math.abs(delta).toFixed(1)}${metric?.startsWith("amount:") ? "" : " pt"}`;

  return react.createElement(
    "div",
    { className: "balance-meter-trend" },
    react.createElement(
      "div",
      { className: "balance-meter-trend-head" },
      react.createElement(
        "span",
        { className: "balance-meter-trend-title" },
        title,
        react.createElement("span", { className: "balance-meter-trend-code" }, t.trendWindowCode),
      ),
      react.createElement(
        "span",
        { className: "balance-meter-trend-delta" },
        "24H ",
        react.createElement("b", null, deltaText),
      ),
    ),
    react.createElement(
      "div",
      { className: "balance-meter-chart" },
      react.createElement(
        "svg",
        {
          className: "balance-meter-trend-svg",
          viewBox: `0 0 ${W} ${H}`,
          preserveAspectRatio: "xMidYMid meet",
          role: "img",
          "aria-label": title,
        },
        react.createElement(
          "defs",
          null,
          react.createElement(
            "linearGradient",
            { id: "balanceMeterTrendFill", x1: 0, y1: 0, x2: 0, y2: 1 },
            react.createElement("stop", { offset: "0%", stopColor: "#077a63", stopOpacity: 0.22 }),
            react.createElement("stop", { offset: "100%", stopColor: "#077a63", stopOpacity: 0 }),
          ),
          react.createElement(
            "linearGradient",
            { id: "balanceMeterTrendLine", x1: 0, y1: 0, x2: 1, y2: 0 },
            react.createElement("stop", { offset: "0%", stopColor: "#5f8a00" }),
            react.createElement("stop", { offset: "100%", stopColor: "#077a63" }),
          ),
        ),
        react.createElement(
          "g",
          { className: "balance-meter-trend-grid" },
          [14, 34, 54].map((y) =>
            react.createElement("line", { key: y, x1: 2, y1: y, x2: W - 2, y2: y }),
          ),
        ),
        react.createElement("path", { className: "balance-meter-trend-area", d: area, fill: "url(#balanceMeterTrendFill)" }),
        react.createElement("path", {
          className: "balance-meter-trend-line",
          d: path,
          fill: "none",
          stroke: "url(#balanceMeterTrendLine)",
          strokeWidth: 2,
        }),
        react.createElement("circle", {
          className: "balance-meter-trend-dot",
          cx: last.x.toFixed(2),
          cy: last.y.toFixed(2),
          r: 3.5,
        }),
      ),
      react.createElement(
        "div",
        { className: "balance-meter-trend-axis", "aria-hidden": true },
        react.createElement("span", null, "24H"),
        react.createElement("span", null, "12H"),
        react.createElement("span", null, t.trendNow),
      ),
    ),
  );
}

/** 概览行（设置页 / 兼容旧布局）：引擎 / 供应商 / 计费方式 / 余量 / 查询时间。 */
export function summaryRows(react: React, t: Copy, state: MeterState, route: RouteInfo | null) {
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
  );
  // 订阅场景的余量由额度窗口分别给出；再显示一个「当前余量」只会重复第一个窗口。
  if (snapshot?.kind !== "subscription") {
    entries.push([
      t.rowAmount,
      snapshot && snapshot.kind !== "unavailable" ? formatAmount(snapshot) : t.unavailable,
    ]);
  }
  if (snapshot?.planName) entries.push([t.rowPlan, snapshot.planName]);
  if (snapshot?.quotaWindows?.length) entries.push([t.rowDetails, quotaWindows(react, t, snapshot)]);
  else if (snapshot?.detail) entries.push([t.rowBalanceDetail, snapshot.detail]);
  entries.push([t.rowCheckedAt, snapshot ? new Date(snapshot.checkedAt).toLocaleTimeString() : t.neverChecked]);
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

function RefreshButton(props: {
  ctx: PluginContext;
  store: BalanceStore;
  t: Copy;
  refreshing: boolean;
  label: string;
  block?: boolean;
}) {
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

/** 面板的 meta 行（供应商 / 计费方式 / 计划）。 */
function metaRow(
  react: React,
  label: string,
  value: ReturnType<React["createElement"]> | string,
  extra?: ReturnType<React["createElement"]>,
) {
  return react.createElement(
    "div",
    { className: "balance-meter-meta-row" },
    react.createElement("span", { className: "balance-meter-meta-label" }, label),
    react.createElement(
      "span",
      { className: "balance-meter-meta-value", title: typeof value === "string" ? value : undefined },
      value,
      extra ?? null,
    ),
  );
}

/** 状态栏条目：胶囊触发按钮 + 悬浮遥测面板。 */
export function makeChip(ctx: PluginContext, store: BalanceStore, t: Copy) {
  return function BalanceChip() {
    const react = ctx.react;
    const state = react.useSyncExternalStore(store.subscribe, store.getSnapshot);
    const open = state.panelOpen;
    const rootRef = react.useRef<HTMLSpanElement>(null);
    const [now, setNow] = react.useState(() => Date.now());

    react.useEffect(() => {
      if (!open) return;
      const closeOnOutsidePointer = (event: PointerEvent) => {
        if (isOutsideElement(rootRef.current, event.target)) store.closePanel();
      };
      document.addEventListener("pointerdown", closeOnOutsidePointer, true);
      return () => document.removeEventListener("pointerdown", closeOnOutsidePointer, true);
    }, [open]);

    // 面板打开时每秒走一次，用于「N 分钟前」与刷新冷却倒计时。
    react.useEffect(() => {
      if (!open) return;
      const timer = setInterval(() => setNow(Date.now()), 1000);
      return () => clearInterval(timer);
    }, [open]);

    react.useEffect(() => {
      if (!open) return;
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") store.closePanel();
      };
      document.addEventListener("keydown", onKeyDown);
      return () => document.removeEventListener("keydown", onKeyDown);
    }, [open]);

    const snapshot = state.snapshot;
    const route = state.currentRoute;
    const parts = chipParts(snapshot, t);
    const tooltip =
      snapshot && snapshot.kind !== "unavailable"
        ? `${snapshot.providerName} · ${billingLabel(t, snapshot.billing)}`
        : `${t.unavailable}${snapshot?.error ? `（${snapshot.error}）` : ""}`;

    const trigger = react.createElement(
      "button",
      {
        type: "button",
        className: `balance-meter-trigger${open ? " is-open" : ""}${state.refreshing ? " is-syncing" : ""}`,
        "aria-label": t.chipAria,
        "aria-expanded": open ? "true" : "false",
        title: tooltip,
        onClick: (event: { stopPropagation: () => void }) => {
          event.stopPropagation();
          store.togglePanel();
        },
      },
      react.createElement("span", { className: "balance-meter-trigger-dot", "aria-hidden": true }),
      react.createElement(
        "span",
        { className: "balance-meter-trigger-text" },
        parts.lead ? `${parts.lead} ` : "",
        react.createElement("b", null, parts.value),
      ),
      icon(react, CHEVRON_PATHS, 12),
    );

    if (!open) {
      return react.createElement("span", { className: "balance-meter-wrap", ref: rootRef }, trigger);
    }

    const primary = primaryWindow(snapshot);
    const metric = quotaMetric(snapshot);
    const value = quotaValue(snapshot);
    const heroValue = primary ? primary.remaining : snapshot?.amount ?? null;
    const samples = route ? state.history[route.routeKey] ?? [] : [];
    const windows = [...(snapshot?.quotaWindows ?? [])].sort(
      (a, b) =>
        (a.durationMins ?? (a.kind === "weekly" ? 10080 : a.kind === "monthly" ? 43200 : 0)) -
        (b.durationMins ?? (b.kind === "weekly" ? 10080 : b.kind === "monthly" ? 43200 : 0)),
    );
    const cooldownLeft = Math.max(0, Math.ceil((state.cooldownUntil - now) / 1000));

    const hero = react.createElement(
      "section",
      { className: "balance-meter-hero balance-meter-stagger", style: { "--i": 1 } as never },
      react.createElement(
        "div",
        { className: "balance-meter-hero-copy" },
        react.createElement(
          "div",
          { className: "balance-meter-kicker" },
          primary ? t.heroKicker(shortWindowLabel(t, primary)) : t.heroBalanceKicker,
        ),
        react.createElement(
          "div",
          { className: "balance-meter-hero-value" },
          heroValue === null
            ? "—"
            : primary
              ? react.createElement(HeroNumber, { react, value: heroValue })
              : formatAmount(snapshot),
          primary ? react.createElement("span", { className: "balance-meter-pct" }, "%") : null,
        ),
        primary && primary.resetAt
          ? react.createElement(
              "div",
              { className: "balance-meter-hero-meta" },
              react.createElement("span", { className: "balance-meter-mini-dot", "aria-hidden": true }),
              t.resetLabel,
              react.createElement("span", { className: "balance-meter-mono" }, shortDateTime(primary.resetAt)),
            )
          : snapshot?.detail
            ? react.createElement("div", { className: "balance-meter-hero-meta" }, snapshot.detail)
            : null,
      ),
      primary
        ? react.createElement(Gauge, { react, value: primary.remaining })
        : react.createElement(
            "div",
            { className: "balance-meter-wallet-badge", "aria-hidden": true },
            icon(react, WALLET_PATHS, 26),
          ),
    );

    const windowRows = windows.map((window, index) =>
      react.createElement(
        "div",
        {
          className: "balance-meter-quota balance-meter-stagger",
          style: { "--i": index + 3 } as never,
          key: `${window.kind}:${window.durationMins ?? ""}`,
        },
        react.createElement(
          "div",
          { className: "balance-meter-q-top" },
          react.createElement(
            "div",
            { className: "balance-meter-q-name" },
            snapshot?.planName ? `${snapshot.planName} · ` : "",
            windowLabel(t, window),
            react.createElement(
              "span",
              { className: "balance-meter-q-code" },
              String(index + 1).padStart(2, "0"),
            ),
          ),
          react.createElement(
            "div",
            { className: "balance-meter-q-val" },
            react.createElement("b", null, Math.round(window.remaining)),
            "%",
          ),
        ),
        react.createElement(QuotaBar, {
          react,
          value: window.remaining,
          label: `${windowLabel(t, window)} ${Math.round(window.remaining)}%`,
        }),
        react.createElement(
          "div",
          { className: "balance-meter-q-foot" },
          react.createElement(
            "span",
            null,
            t.resetLabel,
            " ",
            react.createElement("span", { className: "balance-meter-mono" }, shortDateTime(window.resetAt)),
          ),
          react.createElement("span", { className: "balance-meter-q-window" }, t.windowIndex(index)),
        ),
      ),
    );

    const panel = react.createElement(
      "div",
      {
        className: `balance-meter-panel${state.refreshing ? " is-scanning" : ""}`,
        role: "dialog",
        "aria-label": t.panelTitle,
      },
      react.createElement("span", { className: "balance-meter-sheen", "aria-hidden": true }),
      react.createElement("span", { className: "balance-meter-corner c-tl", "aria-hidden": true }),
      react.createElement("span", { className: "balance-meter-corner c-tr", "aria-hidden": true }),
      react.createElement("span", { className: "balance-meter-corner c-bl", "aria-hidden": true }),
      react.createElement("span", { className: "balance-meter-corner c-br", "aria-hidden": true }),
      react.createElement("span", { className: "balance-meter-scan", "aria-hidden": true }),

      react.createElement(
        "header",
        { className: "balance-meter-panel-head balance-meter-stagger", style: { "--i": 0 } as never },
        react.createElement(
          "div",
          { className: "balance-meter-head-title" },
          react.createElement("span", { className: "balance-meter-status-dot", "aria-hidden": true }),
          t.panelTitle,
          react.createElement("span", { className: "balance-meter-head-code" }, t.panelCode),
        ),
        react.createElement(
          "button",
          {
            type: "button",
            className: "balance-meter-close-btn",
            "aria-label": t.close,
            title: t.close,
            onClick: () => store.closePanel(),
          },
          icon(react, CLOSE_PATHS, 13),
        ),
      ),

      hero,

      windows.length > 0 &&
        react.createElement(
          "div",
          { className: "balance-meter-section-label balance-meter-stagger", style: { "--i": 2 } as never },
          react.createElement("span", null, t.sectionQuota),
          react.createElement("span", { className: "balance-meter-label-code" }, t.sectionQuotaCode(windows.length)),
        ),

      ...windowRows,

      snapshot?.kind === "unavailable" && snapshot.error
        ? react.createElement(
            "p",
            { className: "balance-meter-note balance-meter-stagger", style: { "--i": 5 } as never },
            `${t.unavailable}：${snapshot.error}`,
          )
        : null,

      // 余额渠道也画趋势（采样值是金额）；样本不足时组件自己显示提示。
      snapshot &&
        snapshot.kind !== "unavailable" &&
        react.createElement(
          "div",
          { className: "balance-meter-stagger", style: { "--i": 5 } as never },
          react.createElement(Trend, {
            react,
            t,
            samples,
            metric,
            title: primary
              ? t.trendTitlePlan(shortWindowLabel(t, primary))
              : t.trendTitleBalance,
          }),
        ),

      react.createElement(
        "div",
        { className: "balance-meter-meta balance-meter-stagger", style: { "--i": 6 } as never },
        metaRow(react, t.rowProvider, snapshot?.providerName ?? "—"),
        metaRow(react, t.rowBilling, billingLabel(t, snapshot?.billing ?? "unknown")),
        snapshot?.planName ? metaRow(react, t.rowPlan, snapshot.planName) : null,
        route
          ? react.createElement(EndpointBlock, { key: route.routeKey, ctx, store, t, route })
          : react.createElement("p", { className: "balance-meter-note" }, t.settingsEmpty),
        react.createElement(
          "div",
          { className: "balance-meter-meta-row" },
          react.createElement("span", { className: "balance-meter-meta-label" }, t.rowCheckedAt),
          react.createElement(
            "span",
            { className: "balance-meter-meta-value balance-meter-reading" },
            react.createElement("span", { className: "balance-meter-mini-dot", "aria-hidden": true }),
            relativeTime(t, snapshot?.checkedAt, now),
            react.createElement("span", { className: "balance-meter-read-code" }, t.readAuto),
          ),
        ),
      ),

      react.createElement(
        "footer",
        { className: "balance-meter-panel-foot balance-meter-stagger", style: { "--i": 7 } as never },
        react.createElement(
          "div",
          { className: "balance-meter-foot-meta" },
          react.createElement(
            "span",
            null,
            t.footMinInterval,
            " ",
            react.createElement("span", { className: "balance-meter-mono" }, `${state.minIntervalSec}s`),
          ),
          react.createElement(
            "span",
            { className: `balance-meter-cool-state${cooldownLeft > 0 ? " is-cooling" : ""}` },
            cooldownLeft > 0 ? `${t.settingsCooling} ${cooldownLeft}s` : t.coolReady,
          ),
        ),
        react.createElement(
          "div",
          { className: "balance-meter-foot-actions" },
          react.createElement(
            "button",
            {
              type: "button",
              className: "balance-meter-panel-close",
              onClick: () => store.closePanel(),
            },
            icon(react, CLOSE_PATHS, 12),
            t.closePanelLabel,
            react.createElement("span", { className: "balance-meter-key-hint" }, t.keyHint),
          ),
          react.createElement(
            "button",
            {
              type: "button",
              className: `balance-meter-refresh${state.refreshing ? " is-spinning" : ""}`,
              disabled: state.refreshing || cooldownLeft > 0,
              onClick: () => {
                void store.refresh("manual");
              },
            },
            react.createElement(
              "span",
              { className: "balance-meter-refresh-ico", "aria-hidden": true },
              icon(react, REFRESH_PATHS, 15),
            ),
            react.createElement(
              "span",
              null,
              state.refreshing
                ? t.refreshing
                : cooldownLeft > 0
                  ? `${t.settingsCooling} ${cooldownLeft}s`
                  : t.refresh,
            ),
          ),
        ),
      ),
    );

    return react.createElement(
      "span",
      { className: "balance-meter-wrap", ref: rootRef },
      trigger,
      panel,
    );
  };
}

/** 大数字：整数部分滚动，避免每秒重渲染整棵面板。 */
function HeroNumber(props: { react: React; value: number }) {
  const shown = useCountUp(props.react, props.value, 1150);
  return props.react.createElement("span", null, Math.round(shown));
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
