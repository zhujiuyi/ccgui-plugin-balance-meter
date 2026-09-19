# balance-meter（余额与余量）

CC GUI 插件 · 独立仓库 `zhujiuyi/ccgui-plugin-balance-meter`，本地路径
`E:\ccgui-plugin\plugin-balance-meter`（`E:\ccgui-plugin` 只是容器目录，不再是仓库）。
**本仓即源码与发版的唯一出处**（2026-09-20 从原 monorepo 拆出）。

```bash
pnpm install
pnpm typecheck && pnpm test        # 单测：路由/供应商/缓存/编辑态/跨平台分支
pnpm build                         # 产物 → %TEMP%\ccgui-plugin\balance-meter\dist（本地）
pnpm validate                      # 本地预检（镜像市场 CI 门槛）
```

本地调试：CC GUI → 设置 → 插件 → **从本地目录安装** → 选产物目录（本地默认在 `%TEMP%` 下）。
改完重新 build 再装一次即可（宿主是拷贝快照 + 立即热加载，不用重启）。

发版：改 `manifest.json` 的 `version` → `git tag <version> && git push origin <version>`，
GitHub Action 会构建并把 `main.js` / `manifest.json` / `checksums.txt` 挂到 Release
（CI 里产物走 `CCGUI_PLUGIN_OUT_DIR=dist`，样式内联在 main.js，故不产出 styles.css）。

CC GUI 插件：**按当前实际路由的网关地址识别供应商与计费方式**，然后查询：

- **API 计费**的供应商 → 余额接口（如 DeepSeek `GET /user/balance`）
- **订阅计划** → 订阅/配额余量接口
- 两者都查不到 → 显示「暂时无法提供余额显示」

## 工作方式

1. **识别路由**：读取 `~/.ccgui-next/config.json` 的 `providers` / `current`；`current` 为
   `__local_settings_json__` 时改读该引擎自己的配置（claude → `~/.claude/settings.json` 的
   `ANTHROPIC_BASE_URL`；codex → `~/.codex/config.toml` 的 `base_url`）。
2. **判断供应商**：按网关主机名匹配内置供应商目录；未命中则按 New-API / One-API 系
   中转的常见余量接口逐个探测。
3. **缓存与再发现**：查询成功的**接口地址按路由（主机+路径前缀）缓存**在插件 KV；
   下次直接命中。若缓存地址失效，自动重新走一遍探测找新地址。
4. **刷新**：状态栏 chip 点击打开设置页；设置页有「立即刷新」；一轮对话结束
   （`usage://done`）后按最小间隔自动刷新（可关）。

## 权限说明（重要）

插件声明了 `exec:curl`、`exec:cmd`（Windows）与 `exec:sh`（macOS / Linux）：宿主的网络出口（`plugin_http_request`）要求
**预先声明具体域名**，而"按实际路由动态识别中转站"本质上无法预知域名，因此本插件
通过 `curl` 发请求、用 `cmd` / `sh` 展开用户目录读取 CLI 配置。密钥只用于向**该路由自己的
供应商**发起只读查询，不写入日志、不外发第三方。

## 适用平台

| 平台 | 状态 | 说明 |
|---|---|---|
| **Windows** | ✅ **已实测**（2026-09） | `cmd /d /c echo %USERPROFILE%` 定位家目录；家目录为 `C:\Users\x` 时路径沿用 `\`（读取时转成 `file:///C:/…`）。 |
| **macOS / Linux** | ⚠️ **已适配、未真机验证** | 改用 `sh -c 'printf %s "$HOME"'`，路径用 `/`；curl 参数（`-s -S -L --max-time -o - -w`）本身跨平台通用。 |

跨平台差异只集中在两处：家目录探测命令（`cmd` ↔ `sh`）与路径分隔符（跟随家目录风格）。
平台判断读 webview 的 `navigator.userAgentData.platform` / `navigator.userAgent`，判不出来时按
已实测的 Windows 分支走。样式侧 `backdrop-filter` 已带 `-webkit-` 前缀（macOS WKWebView 需要），
Linux WebKitGTK 若不支持毛玻璃会退化为半透明底；`color-mix()` 在旧 WebKit 上退化为无底色，都不影响功能。

## 两个必须知道的实现坑（否则样式/路由都会错）

1. **样式必须走 `ctx.theme.injectCss`（源码文件名用 `src/ui.css`，构建时 `?inline` 内联），
   不要产出/引入 `styles.css`。** 宿主对插件目录里的 `styles.css` 自动注入时会包进
   `@layer ccgui-plugins`——而层序是
   `@layer ccgui-plugins, theme, base, components, utilities`，即插件层优先级最低；
   Tailwind preflight 在更高的 `base` 层里写着 `button{background-color:transparent;
   border-radius:0}` 与 `*{padding:0;border:0 solid}`，会把插件的按钮底色、圆角、
   内边距、边框整片盖掉（层序优先于选择器特异性）。`ctx.theme.injectCss` 这条路径
   宿主**不套层**，样式才真正生效（代价：需要 `theme` 权限）。
   > 另注：母库 `.gitignore` 忽略 `styles.css` / `main.js`（构建产物名），**源码样式表
   > 别叫 styles.css**，否则会被静默忽略、进不了版本库。
2. **活动引擎的判定顺序**：插件 KV 记忆（`activeEngine`）→ 宿主 localStorage 里持久化的
   活动标签（`ccgui-next.activeSession:v1` 的 `engine`）→ 事件（`session://activated`、
   `usage://updated` / `usage://done` 载荷里的 `engine`）。之所以要读 localStorage：
   ccgui 只在用户点标签/选会话时发激活事件，**应用启动恢复上次标签时不补发**，
   否则插件会退到"第一条路由"而显示成别的引擎的余额。引擎已确认时只认该引擎的路由，
   找不到就报"未识别到该引擎的路由配置"，绝不跨引擎回退。

## 开发

```bash
pnpm install
pnpm typecheck && pnpm test
pnpm build     # 产物落到 %TEMP%\ccgui-plugin\balance-meter\dist\
```

然后在 CC GUI：设置 → 插件 → 从本地目录安装 → 选该 `dist` 目录。改完重新 build 再装一次即可
（宿主安装的是拷贝快照并立即热加载，无需重启）。

## 已知边界

- 官方 Anthropic / OpenAI 的订阅（Pro/Max、ChatGPT）**没有公开余额接口**，会落到"无法查询"。
- 中转站的余量接口差异极大，探测失败的可在设置里用「自定义余量接口」手工指定。

## 收录的供应商（与 ccgui 自定义渠道预设表对齐）

预设表来源：`desktop-cc-gui/src/features/settings/providerPresets.ts`（2026-09-19 对 v1.0.5 核对）。
**没有公开余额接口的也一律收录**，这样提示是"XX 未提供公开的余额/余量查询接口"而不是含糊的"未知供应商"。

| 供应商 | 网关域名 | 计费 | 余额/余量接口 |
|---|---|---|---|
| DeepSeek | api.deepseek.com | API | ✅ `GET /user/balance` |
| OpenRouter | openrouter.ai | API | ✅ `GET /api/v1/credits` |
| Moonshot / Kimi | api.moonshot.cn / .ai | API | ✅ `GET /v1/users/me/balance` |
| SiliconFlow | *.siliconflow.cn/.com | API | ✅ `GET /v1/user/info` |
| OpenAI（官方直连） | api.openai.com | API | ⚠️ `GET /v1/dashboard/billing/subscription`（现多为会话 key 专用） |
| 智谱 GLM | open.bigmodel.cn | API | ❌ 无公开接口 |
| Z.AI 编码套餐 | api.z.ai | 订阅 | ❌ 无公开接口 |
| Kimi Coding | api.kimi.com | 订阅 | ❌ 无公开接口 |
| MiniMax | api.minimaxi.com | API | ❌ 无公开接口 |
| Xiaomi MiMo | api.xiaomimimo.com | API | ❌ 无公开接口 |
| Xiaomi MiMo Token Plan | token-plan-{cn,ams,sgp}.xiaomimimo.com | 订阅 | ❌ 无公开接口 |
| 阿里云百炼 Bailian | *.dashscope.aliyuncs.com | API | ❌ 仅控制台可见 |
| LongCat | api.longcat.chat | API | ❌ 无公开接口 |
| OpenCode Zen / Go | opencode.ai | 订阅 | ❌ 无公开接口 |
| Anthropic 官方 | api.anthropic.com | API | ❌ 无公开接口 |
| OpenAI 订阅 | chatgpt.com | 订阅 | ❌ 无公开接口 |
| xAI Grok | api.x.ai | API | ❌ 无公开接口 |
| Groq / Mistral / Together / Google Gemini | api.groq.com / api.mistral.ai / api.together.xyz / generativelanguage.googleapis.com | API | ❌ 无公开接口 |
| 未识别的中转站 | 任意其它域名 | 由返回值推断 | 依次探测 New-API `/api/user/self`、OpenAI 兼容 billing、`/api/v1/credits`、`/api/user/subscription`、`/api/usage` |

> `❌` 的判定依据：2026-09-19 对这些域名逐一做过无密钥 GET 探测，常见余额路径全部 404
> （个别站点任何路径都回 200，则由响应结构解析拦截）。若某家后来上线了接口，把路径填进
> 设置里的「自定义余量接口」即可，无需改代码。
