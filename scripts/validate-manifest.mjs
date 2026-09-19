#!/usr/bin/env node
/**
 * 本地预检（镜像 ccgui 插件市场的 CI 门槛）：发布前跑一遍，避免 PR 被 CI 打回。
 *
 * 用法：
 *   node scripts/validate-manifest.mjs                 # 校验仓库根的 manifest.json
 *   node scripts/validate-manifest.mjs --dir dist      # 额外校验产物目录
 *   node scripts/validate-manifest.mjs --tag 0.1.0     # 额外校验 tag 与 version 一致
 *
 * 检查项（与索引仓 scripts/validate.mjs 同源口径）：
 *   manifest 必填/格式、permissions 形状（基座集 + network:/exec:）、
 *   main.js 存在与体积上限、JS 黑名单、README/LICENSE、tag↔version。
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname, "..");

/** 基座权限（与 packages/plugin-sdk/spec/permissions.json 的 knownPermissions 对齐）。 */
const KNOWN_PERMISSIONS = new Set([
  "storage",
  "ui:settings-section",
  "ui:add-menu",
  "ui:composer-status",
  "ui:panel-tab",
  "ui:status-bar",
  "ui:command",
  "ui:markdown",
  "ui:page",
  "ui:timeline-row",
  "ui:session-menu",
  "theme",
  "i18n",
  "events",
  "network:none",
  "composer:draft",
  "host:session",
  "host:workspace",
  "host:workspace:remote",
]);

const NETWORK_GRANT_RE = /^([A-Za-z0-9.-]+)(?::(\d+)(?:-(\d+))?)?$/;
const EXEC_BIN_RE = /^[A-Za-z0-9._-]+$/;
const MAIN_WARN_BYTES = 512 * 1024;
const MAIN_MAX_BYTES = 2 * 1024 * 1024;

const JS_BLACKLIST = [
  { re: /\beval\s*\(/, label: "eval(" },
  { re: /new\s+Function\s*\(/, label: "new Function(" },
  { re: /__TAURI__/, label: "__TAURI__" },
  { re: /\blocalStorage\b/, label: "localStorage" },
  { re: /import\s*\(\s*['"`]https?:\/\//, label: "远程 import(" },
];

const errors = [];
const warnings = [];

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const dir = path.resolve(ROOT, argValue("--dir") ?? ".");
const tag = argValue("--tag");

function isNetworkGrant(value) {
  const body = value.slice("network:".length);
  if (body.toLowerCase() === "none") return false;
  const match = NETWORK_GRANT_RE.exec(body);
  if (!match) return false;
  if (match[2] === undefined) return true;
  const from = Number(match[2]);
  const to = match[3] === undefined ? from : Number(match[3]);
  return from >= 1 && to <= 65535 && from <= to;
}

function isKnownPermission(value) {
  if (KNOWN_PERMISSIONS.has(value)) return true;
  if (value.startsWith("network:")) return isNetworkGrant(value);
  if (value.startsWith("exec:")) return EXEC_BIN_RE.test(value.slice("exec:".length));
  return false;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/* ── manifest ── */
const manifestPath = path.join(dir, "manifest.json");
if (!existsSync(manifestPath)) {
  errors.push(`缺少 manifest.json：${manifestPath}`);
} else {
  const manifest = readJson(manifestPath);
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(manifest.id ?? "")) {
    errors.push(`id 非法："${manifest.id}"（小写字母/数字/连字符）`);
  }
  if (!manifest.name?.trim()) errors.push("name 缺失");
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version ?? "")) {
    errors.push(`version 必须三段 semver："${manifest.version}"`);
  }
  if (!["declarative", "js"].includes(manifest.tier)) errors.push('tier 必须是 "declarative" | "js"');
  if (manifest.minAppVersion && !/^\d+\.\d+\.\d+$/.test(manifest.minAppVersion)) {
    errors.push(`minAppVersion 非法："${manifest.minAppVersion}"`);
  }
  for (const permission of manifest.permissions ?? []) {
    if (!isKnownPermission(permission)) errors.push(`未知权限："${permission}"`);
  }
  if (manifest.tier === "js" && (manifest.permissions ?? []).length === 0) {
    warnings.push("tier=js 但未声明任何权限");
  }
  if (tag) {
    const normalized = tag.replace(/^v/, "");
    if (normalized !== manifest.version) {
      errors.push(`tag ${tag} 与 manifest.version ${manifest.version} 不一致`);
    }
  }
  console.log(`manifest: ${manifest.id}@${manifest.version} (${manifest.tier})`);
  console.log(`  permissions: ${(manifest.permissions ?? []).join(", ") || "（无）"}`);
}

/* ── main.js（存在时校验体积与黑名单）── */
const mainPath = path.join(dir, "main.js");
if (existsSync(mainPath)) {
  const size = statSync(mainPath).size;
  const sha = createHash("sha256").update(readFileSync(mainPath)).digest("hex");
  console.log(`main.js: ${size} bytes, sha256 ${sha.slice(0, 12)}…`);
  if (size > MAIN_MAX_BYTES) errors.push(`main.js ${size} 字节超过 2MB 硬上限`);
  else if (size > MAIN_WARN_BYTES) warnings.push(`main.js ${size} 字节超过 512KB 警告阈值`);
  const text = readFileSync(mainPath, "utf8");
  for (const { re, label } of JS_BLACKLIST) {
    if (re.test(text)) errors.push(`main.js 命中黑名单 "${label}"`);
  }
} else if (dir !== ROOT) {
  errors.push(`产物目录缺 main.js：${mainPath}`);
}

/* ── README / LICENSE ── */
for (const file of ["README.md", "LICENSE"]) {
  if (!existsSync(path.join(ROOT, file))) errors.push(`仓库根缺 ${file}`);
}

/* ── 结论 ── */
for (const warning of warnings) console.warn(`⚠️  ${warning}`);
for (const error of errors) console.error(`❌ ${error}`);
if (errors.length > 0) {
  console.error(`\n预检未通过：${errors.length} 项错误`);
  process.exit(1);
}
console.log(`\n✅ 预检通过${warnings.length ? `（${warnings.length} 项警告）` : ""}`);
