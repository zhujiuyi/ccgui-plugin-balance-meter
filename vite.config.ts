import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin } from "vite";

/**
 * 单文件 ESM 产物（宿主以 blob URL 加载 main.js，裸导入无法解析，
 * 因此不做 external、不做动态 import）。
 *
 * 按仓库约定，产物不落进源码目录：默认输出到
 * `%TEMP%\ccgui-plugin\balance-meter\dist\`，并把 manifest.json 一并
 * 拷过去，使该目录可直接用于「设置 → 插件 → 从本地目录安装」。
 */
/**
 * 产物目录：
 *  - 本地开发（母库约定）：`%TEMP%\ccgui-plugin\balance-meter\dist`，源码目录保持干净；
 *  - CI / 发版：用 `CCGUI_PLUGIN_OUT_DIR=dist` 覆盖，产物落在仓库内 `dist/`（.gitignore）；
 *  - 两者都没有时退到仓库内 `dist/`。
 */
const tempRoot = process.env.TEMP ?? process.env.TMP;
const stageDir = process.env.CCGUI_PLUGIN_OUT_DIR?.trim()
  ? path.resolve(__dirname, process.env.CCGUI_PLUGIN_OUT_DIR.trim())
  : tempRoot
    ? path.join(tempRoot, "ccgui-plugin", "balance-meter", "dist")
    : path.resolve(__dirname, "dist");

/** 把仓库根的 manifest.json 拷进产物目录（装机需要三件套同目录）。 */
function stageManifest(): Plugin {
  return {
    name: "balance-meter:stage-manifest",
    closeBundle() {
      fs.mkdirSync(stageDir, { recursive: true });
      fs.copyFileSync(path.resolve(__dirname, "manifest.json"), path.join(stageDir, "manifest.json"));
    },
  };
}

export default defineConfig({
  plugins: [stageManifest()],
  define: {
    // 依赖里可能带 Node 风格 NODE_ENV 判断；webview 里没有 `process`。
    "process.env.NODE_ENV": '"production"',
  },
  build: {
    outDir: stageDir,
    emptyOutDir: true,
    // 不压缩：市场审核偏好可读产物（也避免"压缩后参数改名"导致
    // 索引仓 permissions 启发式扫不到 ctx.* 调用而报"权限多余"）。
    minify: false,
    cssCodeSplit: false,
    lib: {
      entry: path.resolve(__dirname, "src/main.ts"),
      formats: ["es"],
      fileName: () => "main.js",
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        banner: "var process = { env: { NODE_ENV: 'production' } };",
        assetFileNames: (asset) =>
          asset.name?.endsWith(".css") ? "styles.css" : (asset.name ?? "asset"),
      },
    },
  },
});
