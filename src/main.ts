/**
 * balance-meter 入口：装配状态机、事件与 UI 注册项。
 * 所有注册都返回 Disposer（宿主卸载时逆序清理），本插件只额外清理定时器/监听。
 */

// 关键：**不用** `import "./styles.css"`。宿主对插件目录里的 styles.css 会自动注入，
// 但会包进最低优先级的 `@layer ccgui-plugins`（宿主故意如此，防止插件改宿主样式），
// 结果是 Tailwind preflight（`* { padding: 0; border: 0 solid }`、`button { background: transparent;
// border-radius: 0 }`，位于更高的 base 层）把插件的 padding/border/按钮底色全部盖掉。
// 改用 `ctx.theme.injectCss` 注入：宿主该路径**不套层**，样式才真正生效。
// 文件名为 ui.css（不叫 styles.css）：仓库 .gitignore 按产物名忽略了 styles.css/main.js，
// 源码若叫 styles.css 会被一起忽略、根本进不了版本库。
import styles from "./ui.css?inline";

import type { PluginContext } from "./ccgui-plugin";
import { copy } from "./i18n";
import { BalanceStore } from "./state";
import { makeChip, makeSettingsSection } from "./ui";

const CONFIG_CHANGED_TOPIC = "plugin-config://changed";

export default function activate(ctx: PluginContext) {
  const t = copy(ctx.host.locale);
  const store = new BalanceStore(ctx, t);
  ctx.theme.injectCss(styles);
  void store.init();

  // usage 载荷自带 engine：宿主启动恢复标签时不发 session://activated，
  // 所以这里同时用它来对准"当前引擎"（否则会显示错误引擎的余额）。
  ctx.events.on("usage://updated", (data) => {
    store.onEngineSeen((data as { engine?: string } | null)?.engine);
  });

  // 需求 2：一轮对话结束（usage://done）后按最小间隔自动刷新。
  ctx.events.on("usage://done", (data) => {
    store.onEngineSeen((data as { engine?: string } | null)?.engine);
    void store.onTurnEnd();
  });
  // 切换会话/标签意味着可能换了引擎（进而换了网关），按新路由查询。
  ctx.events.on("session://activated", (data) => {
    store.onSessionActivated(data as { engine?: string | null });
  });
  ctx.events.on(CONFIG_CHANGED_TOPIC, (data) => {
    const payload = data as { pluginId?: string } | null;
    if (payload?.pluginId && payload.pluginId !== ctx.pluginId) return;
    void store.reloadConfig();
  });

  ctx.ui.registerStatusBarItem({
    component: makeChip(ctx, store, t),
    zone: "start",
  });
  ctx.ui.registerSettingsSection({
    label: () => t.settingsTitle,
    component: makeSettingsSection(ctx, store, t),
  });
  ctx.ui.registerCommand({
    key: "refresh",
    title: () => t.cmdRefreshTitle,
    run: () => {
      void store.refresh("manual");
    },
  });

  return () => store.dispose();
}
