#!/usr/bin/env node
/**
 * GPT2Image-Pro 本地 updater CLI 骨架。
 * 使用方：运维手动 dry-run、后续 Admin/UOL 适配层和 CI smoke；本脚本当前覆盖本地 apply 前半段闭环。
 * 关键依赖：Node.js 内置模块、binary-style manifest helper、安装根目录中的 current-version 与 manifest 文件。
 */

import { spawnSync } from "node:child_process";
import { constants as fsConstants, createWriteStream } from "node:fs";
import {
  access,
  appendFile,
  cp,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertObject,
  pathExists,
  readJson,
  requiredBundlePaths,
  supportedPlatform,
  sha256File,
  verifyArtifact,
  verifyDeniedPaths,
  verifyManifest,
  verifyRequiredPaths,
  verifySchemaBaseline,
  verifySha256Sums,
} from "./binary-style-release-lib.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const commandNames = new Set([
  "apply",
  "check",
  "download",
  "plan",
  "stage",
  "status",
  "dry-run",
  "update",
]);
const supportedArgs = new Set([
  "artifact-file",
  "checksum-file",
  "current-version",
  "dry-run",
  "env-file",
  "help",
  "install-root",
  "manifest",
  "platform",
  "run-id",
  "self-test",
]);
const projectVersionPattern =
  /^v([0-9]+)\.([0-9]+)\.([0-9]+)(?:-(alpha|beta|rc)\.([0-9]+))?$/;
const defaultRuntimeEnvFile = "/etc/gpt2image/gpt2image.env";
const defaultUpdaterLogPath = "/var/log/gpt2image/updater.log";
const requiredRuntimeEnvNames = ["DATABASE_URL", "BETTER_AUTH_SECRET"];
const requiredApplyEnvNames = [
  ...requiredRuntimeEnvNames,
  "CHATGPT_WEB_PROXY_SECRET",
];
export const ALLOWED_SYSTEMD_UNITS = Object.freeze([
  "gpt2image-web.service",
  "gpt2image-chatgpt-web-proxy.service",
]);
const forbiddenRuntimeScopeTokens = new Set([
  "admin",
  "docker",
  "nginx",
  "postgres",
  "postgresql",
  "uol",
  "ui",
]);
const sensitiveTextNames = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "CHATGPT_WEB_PROXY_SECRET",
];
const redactedValue = "[REDACTED]";
const prereleaseRank = new Map([
  ["alpha", 0],
  ["beta", 1],
  ["rc", 2],
]);

/**
 * 解析命令行参数。
 * @param {string[]} argv 参数。
 * @returns {{ command: string | undefined, args: Map<string, string | boolean> }} 命令与参数映射。
 */
export function parseArgs(argv) {
  const args = new Map();
  let command;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      if (!command) {
        command = token;
        continue;
      }
      throw new Error(`Unexpected argument: ${token}`);
    }

    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    if (!rawKey || !supportedArgs.has(rawKey)) {
      throw new Error(`Unsupported argument: --${rawKey}`);
    }
    if (inlineValue !== undefined) {
      args.set(rawKey, inlineValue);
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args.set(rawKey, next);
      index += 1;
    } else {
      args.set(rawKey, true);
    }
  }

  return { command, args };
}

/**
 * 读取字符串参数。
 * @param {Map<string, string | boolean>} args 参数映射。
 * @param {string} key 参数名。
 * @returns {string | undefined} 字符串值。
 */
export function readStringArg(args, key) {
  const value = args.get(key);
  if (typeof value === "boolean") {
    throw new Error(`--${key} requires a value`);
  }
  return value;
}

/**
 * 断言条件成立。
 * @param {boolean} condition 条件。
 * @param {string} message 错误消息。
 * @returns {void} 无返回。
 */
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

/**
 * 遮蔽日志或错误消息中的敏感文本。
 * @param {unknown} value 待输出内容。
 * @returns {string} 已脱敏文本。
 */
export function redactSensitiveText(value) {
  let text = String(value);
  for (const name of sensitiveTextNames) {
    text = text.replace(
      new RegExp(`(${name}\\s*=\\s*)([^\\s\\r\\n'"]+)`, "gi"),
      `$1${redactedValue}`,
    );
    text = text.replace(
      new RegExp(`("${name}"\\s*:\\s*")([^"]*)(")`, "gi"),
      `$1${redactedValue}$3`,
    );
  }
  return text
    .replace(/postgres(?:ql)?:\/\/[^\s'",]+/gi, `postgresql://${redactedValue}`)
    .replace(
      /(Authorization\s*[:=]\s*)(Bearer\s+)?[^\s'",]+/gi,
      `$1${redactedValue}`,
    )
    .replace(/(Cookie\s*[:=]\s*)[^\r\n"]+/gi, `$1${redactedValue}`);
}

/**
 * 打印帮助文本。
 * @returns {string} 帮助文本。
 */
function formatHelp() {
  return `GPT2Image-Pro local updater CLI

Usage:
  node scripts/local-updater.mjs --help
  node scripts/local-updater.mjs check --manifest <manifest.json|file://|https://> --current-version <version> [--platform linux-x64] [--dry-run]
  node scripts/local-updater.mjs download --install-root <dir> --manifest <manifest.json|file://|https://> [--artifact-file <file>] [--checksum-file <file>] [--run-id <id>]
  node scripts/local-updater.mjs plan --install-root <dir> --manifest <manifest.json|file://|https://> [--current-version <version>] [--dry-run]
  node scripts/local-updater.mjs stage --install-root <dir> --manifest <manifest.json|file://|https://> --artifact-file <file> [--env-file <file>] [--run-id <id>]
  node scripts/local-updater.mjs status --install-root <dir> [--dry-run]
  node scripts/local-updater.mjs dry-run --install-root <dir> --manifest <manifest.json|file://|https://>
  node scripts/local-updater.mjs apply --install-root <dir> --manifest <manifest.json|file://|https://> --env-file /etc/gpt2image/gpt2image.env [--artifact-file <file>] [--run-id <id>]
  node scripts/local-updater.mjs update --install-root <dir> --manifest <manifest.json|file://|https://> --env-file /etc/gpt2image/gpt2image.env [--artifact-file <file>] [--run-id <id>]
  node scripts/local-updater.mjs --self-test
  node scripts/local-updater.mjs --self-test cli
  node scripts/local-updater.mjs --self-test check

Commands:
  apply     Run Phase 4 preflight, install staged bundle, run pre-switch DB migration, switch current, then restart whitelisted services.
  check     Validate a detached manifest without downloading or writing files.
  download  Download or copy an artifact into shared/staging with .partial cleanup and checksum verification.
  plan      Build a read-only update plan for a manifest and install root.
  stage     Extract a verified artifact into shared/staging and run local preflight only.
  status    Read optional current-version and manifest status from install root.
  dry-run   Alias for a full read-only plan; it never switches current or restarts services.
  update    Alias for apply.

Phase 4 skeleton boundary:
  apply/update require explicit --install-root, --manifest, and --env-file.
  The documented env-file default is /etc/gpt2image/gpt2image.env, but pass it explicitly.
  The skeleton inspects current, releases, shared/staging, and shared/updater.lock.
  With --artifact-file it writes releases/.installing-<run-id>, verifies, renames to releases/<version>, then runs releases/<version>/migrator.
  It plans status checks only for gpt2image-web.service and gpt2image-chatgpt-web-proxy.service.
  It refuses PostgreSQL, Nginx, Docker, Admin, UOL, and UI runtime scopes.
  DB migration uses pre_switch mode and is not automatically reversible.
  It only restarts gpt2image-web.service and gpt2image-chatgpt-web-proxy.service, then runs healthcheck rollback if probes fail.`;
}

/**
 * 读取可选文本文件。
 * @param {string} filePath 文件路径。
 * @returns {Promise<{ path: string, exists: boolean, value?: string }>} 文件状态。
 */
async function readOptionalTextFile(filePath) {
  if (!(await pathExists(filePath))) {
    return { path: filePath, exists: false };
  }
  return {
    path: filePath,
    exists: true,
    value: (await readFile(filePath, "utf8")).trim(),
  };
}

/**
 * 读取可选 manifest 并只返回非敏感摘要。
 * @param {string} filePath manifest 路径。
 * @returns {Promise<{ path: string, exists: boolean, version?: string, platform?: string }>} manifest 状态。
 */
async function readOptionalManifestSummary(filePath) {
  if (!(await pathExists(filePath))) {
    return { path: filePath, exists: false };
  }
  const manifest = await readJson(filePath);
  return {
    path: filePath,
    exists: true,
    version: typeof manifest.version === "string" ? manifest.version : undefined,
    platform: typeof manifest.platform === "string" ? manifest.platform : undefined,
  };
}

/**
 * 读取可选 JSON 摘要，供 shared/updater.lock metadata 等非 manifest 文件使用。
 * @param {string} filePath JSON 路径。
 * @returns {Promise<object>} JSON 摘要。
 */
async function readOptionalJsonSummary(filePath) {
  if (!(await pathExists(filePath))) {
    return { path: filePath, exists: false };
  }
  try {
    return {
      path: filePath,
      exists: true,
      value: await readJson(filePath),
    };
  } catch (error) {
    return {
      path: filePath,
      exists: true,
      error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
    };
  }
}

/**
 * 解析安装根目录参数，未提供时使用仓库根目录作为本地 dry-run 默认值。
 * @param {Map<string, string | boolean>} args 参数映射。
 * @returns {string} 绝对安装根目录。
 */
function resolveInstallRoot(args) {
  const installRoot = readStringArg(args, "install-root") ?? rootDir;
  return path.resolve(installRoot);
}

/**
 * 解析 manifest 来源参数。
 * @param {Map<string, string | boolean>} args 参数映射。
 * @returns {string} manifest 本地路径、file URL 或 HTTPS URL。
 */
function requireManifestSourceArg(args) {
  const manifestSource = readStringArg(args, "manifest");
  assert(Boolean(manifestSource), "--manifest is required");
  return manifestSource;
}

/**
 * 读取 manifest 字符串字段。
 * @param {Record<string, unknown>} manifest manifest。
 * @param {string} field 字段名。
 * @returns {string} 字符串字段。
 */
function readManifestString(manifest, field) {
  const value = manifest[field];
  assert(typeof value === "string", `manifest ${field} must be a string`);
  return value;
}

/**
 * 解析项目版本号。
 * @param {string} version 项目版本号。
 * @returns {{ raw: string, major: number, minor: number, patch: number, prerelease: { label: string, number: number } | null }} 结构化版本。
 */
export function parseProjectVersion(version) {
  const match = projectVersionPattern.exec(version);
  assert(Boolean(match), `invalid project version: ${version}`);

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const prereleaseNumber =
    match[5] === undefined ? undefined : Number(match[5]);

  for (const [label, value] of [
    ["major", major],
    ["minor", minor],
    ["patch", patch],
  ]) {
    assert(Number.isSafeInteger(value), `version ${label} is not safe`);
  }
  if (prereleaseNumber !== undefined) {
    assert(
      Number.isSafeInteger(prereleaseNumber),
      "version prerelease number is not safe",
    );
  }

  return {
    raw: version,
    major,
    minor,
    patch,
    prerelease:
      match[4] === undefined
        ? null
        : { label: match[4], number: prereleaseNumber },
  };
}

/**
 * 比较两个数字。
 * @param {number} left 左值。
 * @param {number} right 右值。
 * @returns {-1 | 0 | 1} 比较结果。
 */
function compareNumbers(left, right) {
  if (left === right) {
    return 0;
  }
  return left > right ? 1 : -1;
}

/**
 * 比较两个项目版本号。
 * @param {string} left 左侧版本。
 * @param {string} right 右侧版本。
 * @returns {-1 | 0 | 1} left 小于、等于或大于 right。
 */
export function compareProjectVersions(left, right) {
  const leftVersion = parseProjectVersion(left);
  const rightVersion = parseProjectVersion(right);

  for (const field of ["major", "minor", "patch"]) {
    const result = compareNumbers(leftVersion[field], rightVersion[field]);
    if (result !== 0) {
      return result;
    }
  }

  if (!leftVersion.prerelease && !rightVersion.prerelease) {
    return 0;
  }
  if (!leftVersion.prerelease) {
    return 1;
  }
  if (!rightVersion.prerelease) {
    return -1;
  }

  const leftRank = prereleaseRank.get(leftVersion.prerelease.label);
  const rightRank = prereleaseRank.get(rightVersion.prerelease.label);
  const labelResult = compareNumbers(leftRank, rightRank);
  if (labelResult !== 0) {
    return labelResult;
  }
  return compareNumbers(
    leftVersion.prerelease.number,
    rightVersion.prerelease.number,
  );
}

/**
 * 决策当前版本是否可更新到 manifest 版本。
 * @param {object} input 输入。
 * @param {string | undefined} input.currentVersion 当前版本。
 * @param {string} input.availableVersion manifest 版本。
 * @param {string} input.minimumSupportedVersion 最低可直接更新版本。
 * @returns {{ decision: string, reason: string }} 决策与原因。
 */
export function decideUpdate({
  currentVersion,
  availableVersion,
  minimumSupportedVersion,
}) {
  parseProjectVersion(availableVersion);
  parseProjectVersion(minimumSupportedVersion);

  if (!currentVersion) {
    return {
      decision: "unknown-current",
      reason: "current version is unavailable",
    };
  }

  parseProjectVersion(currentVersion);
  if (compareProjectVersions(currentVersion, minimumSupportedVersion) < 0) {
    return {
      decision: "minimum-unsupported",
      reason: "current version is older than minimum supported version",
    };
  }

  const versionComparison = compareProjectVersions(
    availableVersion,
    currentVersion,
  );
  if (versionComparison > 0) {
    return {
      decision: "upgrade",
      reason: "available version is newer than current version",
    };
  }
  if (versionComparison === 0) {
    return {
      decision: "no-update",
      reason: "current version already matches available version",
    };
  }
  return {
    decision: "downgrade",
    reason: "available version is older than current version",
  };
}

/**
 * 判断本地路径是否是 Windows 绝对路径。
 * @param {string} source manifest 来源。
 * @returns {boolean} 是否是 Windows 绝对路径。
 */
function isWindowsAbsolutePath(source) {
  return /^[a-zA-Z]:[\\/]/.test(source);
}

/**
 * 读取 manifest 来源。
 * @param {string} source 本地路径、file URL 或 HTTPS URL。
 * @param {{ fetch?: Function }} options 注入项。
 * @returns {Promise<{ source: string, filePath?: string, manifest: Record<string, unknown> }>} manifest 与来源。
 */
export async function readManifestSource(source, options = {}) {
  assert(typeof source === "string" && source.length > 0, "manifest source is required");

  if (source.startsWith("https://")) {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    assert(typeof fetchImpl === "function", "https manifest fetch is not available");
    const response = await fetchImpl(source, {
      method: "GET",
      redirect: "follow",
    });
    assert(
      response && response.ok === true,
      `manifest fetch failed: ${response?.status ?? "unknown"} ${response?.statusText ?? ""}`.trim(),
    );
    const text = await response.text();
    return {
      source,
      manifest: assertObject(JSON.parse(text), source),
    };
  }

  if (source.startsWith("file://")) {
    const filePath = fileURLToPath(source);
    return {
      source,
      filePath,
      manifest: await readJson(filePath),
    };
  }

  if (!isWindowsAbsolutePath(source) && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(source)) {
    throw new Error(`unsupported manifest source: ${source}`);
  }

  const filePath = path.resolve(source);
  return {
    source: filePath,
    filePath,
    manifest: await readJson(filePath),
  };
}

/**
 * 验证 Phase 3 只读边界。
 * @returns {void} 无返回。
 */
function assertReadOnlyBoundary() {
  return;
}

/**
 * 读取安装状态。
 * @param {string} installRoot 安装根目录。
 * @returns {Promise<object>} 状态摘要。
 */
export async function readInstallStatus(installRoot) {
  const absoluteInstallRoot = path.resolve(installRoot);
  return {
    installRoot: absoluteInstallRoot,
    dryRun: true,
    files: {
      currentVersion: await readOptionalTextFile(
        path.join(absoluteInstallRoot, "current-version"),
      ),
      rootManifest: await readOptionalManifestSummary(
        path.join(absoluteInstallRoot, "manifest.json"),
      ),
      currentManifest: await readOptionalManifestSummary(
        path.join(absoluteInstallRoot, "current", "manifest.json"),
      ),
    },
  };
}

/**
 * 从安装状态读取当前版本。
 * @param {object} status 安装状态。
 * @returns {string | undefined} 当前版本。
 */
function readCurrentVersionFromStatus(status) {
  if (status.files.currentVersion.exists) {
    return status.files.currentVersion.value;
  }
  if (status.files.currentManifest.exists) {
    return status.files.currentManifest.version;
  }
  return undefined;
}

/**
 * 解析当前版本，优先使用显式参数。
 * @param {Map<string, string | boolean>} args 参数映射。
 * @returns {Promise<string | undefined>} 当前版本。
 */
async function resolveCurrentVersion(args) {
  const currentVersion = readStringArg(args, "current-version");
  if (currentVersion) {
    parseProjectVersion(currentVersion);
    return currentVersion;
  }

  const status = await readInstallStatus(resolveInstallRoot(args));
  const statusVersion = readCurrentVersionFromStatus(status);
  if (statusVersion) {
    parseProjectVersion(statusVersion);
  }
  return statusVersion;
}

/**
 * 读取 apply/update 必需参数，禁止使用只读命令的默认 install root。
 * @param {Map<string, string | boolean>} args 参数映射。
 * @returns {{ installRoot: string, manifestSource: string, envFile: string }} 必需参数。
 */
function requireApplyRuntimeArgs(args) {
  const installRootArg = readStringArg(args, "install-root");
  assert(Boolean(installRootArg), "--install-root is required for apply/update");
  const manifestSource = readStringArg(args, "manifest");
  assert(Boolean(manifestSource), "--manifest is required for apply/update");
  const envFile = readStringArg(args, "env-file");
  assert(
    Boolean(envFile),
    `--env-file is required for apply/update; pass ${defaultRuntimeEnvFile} explicitly`,
  );
  return {
    installRoot: path.resolve(installRootArg),
    manifestSource,
    envFile: path.resolve(envFile),
  };
}

/**
 * 获取正式 releases 根目录。
 * @param {string} installRoot 安装根目录。
 * @returns {string} releases 目录。
 */
function resolveReleasesRoot(installRoot) {
  return path.join(path.resolve(installRoot), "releases");
}

/**
 * 获取 current 指针路径。
 * @param {string} installRoot 安装根目录。
 * @returns {string} current 路径。
 */
function resolveCurrentPath(installRoot) {
  return path.join(path.resolve(installRoot), "current");
}

/**
 * 读取路径的 lstat，路径不存在时返回 undefined。
 * @param {string} filePath 文件或目录路径。
 * @returns {Promise<import("node:fs").Stats | undefined>} 文件状态。
 */
async function lstatIfExists(filePath) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

/**
 * 校验已存在目录没有 symlink 逃逸，并返回真实路径。
 * @param {string} directoryPath 目录路径。
 * @param {string} parentPath 允许的父目录。
 * @param {string} label 错误标签。
 * @returns {Promise<string>} 真实目录路径。
 */
async function resolveExistingDirectoryRealPath(directoryPath, parentPath, label) {
  const absoluteDirectoryPath = path.resolve(directoryPath);
  const parentRealPath = await realpath(parentPath);
  assertInsideInstallRoot(absoluteDirectoryPath, parentRealPath);
  const directoryStat = await lstat(absoluteDirectoryPath);
  assert(!directoryStat.isSymbolicLink(), `${label} must not be a symlink`);
  assert(directoryStat.isDirectory(), `${label} must be a directory`);
  const directoryRealPath = await realpath(absoluteDirectoryPath);
  assertInsideInstallRoot(directoryRealPath, parentRealPath);
  return directoryRealPath;
}

/**
 * 校验 current 指针不会指向 releases 根目录外。
 * @param {string} currentPath current 路径。
 * @param {string} releasesDir releases 根目录。
 * @returns {Promise<object>} current 边界摘要。
 */
async function assertCurrentPathInsideReleases(currentPath, releasesDir) {
  const currentStat = await lstatIfExists(currentPath);
  if (!currentStat) {
    return { path: currentPath, exists: false };
  }

  const releasesRealPath = await realpath(releasesDir);
  if (currentStat.isSymbolicLink()) {
    const target = await readlink(currentPath);
    const resolvedTarget = path.resolve(path.dirname(currentPath), target);
    assertInsideInstallRoot(resolvedTarget, releasesRealPath);
    if (await pathExists(resolvedTarget)) {
      const targetRealPath = await realpath(resolvedTarget);
      assertInsideInstallRoot(targetRealPath, releasesRealPath);
    }
    return {
      path: currentPath,
      exists: true,
      type: "symlink",
      target,
      resolvedTarget,
    };
  }

  assert(currentStat.isDirectory(), "current must be a symlink or directory");
  const currentRealPath = await realpath(currentPath);
  assertInsideInstallRoot(currentRealPath, releasesRealPath);
  return {
    path: currentPath,
    exists: true,
    type: "directory",
    realPath: currentRealPath,
  };
}

/**
 * 读取 releases/<version> 目标状态，拒绝非空目录与 symlink。
 * @param {string} releaseDir release 目标目录。
 * @param {string} releasesDir releases 根目录。
 * @returns {Promise<{ path: string, exists: boolean, empty: boolean }>} 目标状态。
 */
async function readReleaseDestinationState(releaseDir, releasesDir) {
  const releaseStat = await lstatIfExists(releaseDir);
  if (!releaseStat) {
    return { path: releaseDir, exists: false, empty: true };
  }

  assert(!releaseStat.isSymbolicLink(), "release directory must not be a symlink");
  assert(releaseStat.isDirectory(), "release path must be a directory");
  const releaseRealPath = await realpath(releaseDir);
  const releasesRealPath = await realpath(releasesDir);
  assertInsideInstallRoot(releaseRealPath, releasesRealPath);
  const entries = await readdir(releaseDir);
  assert(
    entries.length === 0,
    `release directory already exists and is non-empty: ${releaseDir}`,
  );
  return { path: releaseDir, exists: true, empty: true };
}

/**
 * 删除可被原子 rename 覆盖的空 release 目标目录。
 * @param {{ path: string, exists: boolean, empty: boolean }} releaseState 目标状态。
 * @returns {Promise<void>} 无返回。
 */
async function removeEmptyReleaseDestination(releaseState) {
  if (releaseState.exists && releaseState.empty) {
    await rm(releaseState.path, { recursive: true, force: true });
  }
}

/**
 * 只清理本次 releases/.installing-<run-id> 临时目录。
 * @param {string} installingDir 临时目录。
 * @param {string} releasesDir releases 根目录。
 * @returns {Promise<void>} 无返回。
 */
async function cleanupInstallingRelease(installingDir, releasesDir) {
  const absoluteInstallingDir = path.resolve(installingDir);
  const absoluteReleasesDir = path.resolve(releasesDir);
  assertInsideInstallRoot(absoluteInstallingDir, absoluteReleasesDir);
  assert(
    path.dirname(absoluteInstallingDir) === absoluteReleasesDir &&
      path.basename(absoluteInstallingDir).startsWith(".installing-"),
    "cleanup path must be releases/.installing-<run-id>",
  );
  await rm(absoluteInstallingDir, { recursive: true, force: true });
}

/**
 * 校验 stageArtifact 返回的 bundleDir 确实来自 shared/staging/<run-id>/stage。
 * @param {object} stageResult stageArtifact 返回值。
 * @param {string} stageDir 预期 stage 目录。
 * @param {string} stagingRoot staging 根目录。
 * @returns {Promise<{ bundleDir: string, bundleRealPath: string }>} bundle 路径。
 */
async function assertStageArtifactBundleDir(stageResult, stageDir, stagingRoot) {
  const result = assertObject(stageResult, "stageArtifact result");
  const bundleDirValue = result.bundleDir;
  assert(
    typeof bundleDirValue === "string" && bundleDirValue.length > 0,
    "stageArtifact result bundleDir is required",
  );
  const absoluteBundleDir = path.resolve(bundleDirValue);
  const stageRealPath = await resolveExistingDirectoryRealPath(
    stageDir,
    stagingRoot,
    "shared/staging/<run-id>/stage",
  );
  assertInsideInstallRoot(absoluteBundleDir, stageRealPath);
  const bundleStat = await lstat(absoluteBundleDir);
  assert(!bundleStat.isSymbolicLink(), "stageArtifact bundleDir must not be a symlink");
  assert(bundleStat.isDirectory(), "stageArtifact bundleDir must be a directory");
  const bundleRealPath = await realpath(absoluteBundleDir);
  assertInsideInstallRoot(bundleRealPath, stageRealPath);
  return { bundleDir: absoluteBundleDir, bundleRealPath };
}

/**
 * 复验已复制的 release bundle 内容和内置 manifest。
 * @param {object} input 输入。
 * @param {string} input.bundleDir bundle 目录。
 * @param {Record<string, unknown>} input.manifest detached manifest。
 * @param {string} input.expectedPlatform 期望平台。
 * @returns {Promise<void>} 无返回。
 */
async function verifyReleaseBundle({ bundleDir, manifest, expectedPlatform }) {
  await verifyRequiredPaths(bundleDir);
  await verifyDeniedPaths(bundleDir);
  await verifySha256Sums(bundleDir);
  const internalManifest = await readJson(path.join(bundleDir, "manifest.json"));
  verifyManifest(internalManifest, expectedPlatform);
  // bundle 内 manifest 的 artifact_sha256 可能是构建时占位值，真实 archive hash 以 detached manifest 为准。
  for (const field of [
    "version",
    "commit",
    "platform",
    "minimum_supported_version",
    "migration_mode",
  ]) {
    assert(
      internalManifest[field] === manifest[field],
      `internal manifest ${field} mismatch`,
    );
  }
}

/**
 * 解析 release 安装相关路径并做越界防护。
 * @param {object} input 输入。
 * @param {string} input.installRoot 安装根目录。
 * @param {Record<string, unknown>} input.manifest manifest。
 * @param {string | undefined} input.runId 执行 ID。
 * @returns {Promise<object>} release 路径集合。
 */
export async function resolveReleasePaths({ installRoot, manifest, runId }) {
  const absoluteInstallRoot = path.resolve(installRoot);
  const installRootStat = await lstat(absoluteInstallRoot);
  assert(
    installRootStat.isDirectory() || installRootStat.isSymbolicLink(),
    "installRoot must be a directory",
  );
  const installRootRealPath = await realpath(absoluteInstallRoot);
  await resolveExistingDirectoryRealPath(
    installRootRealPath,
    installRootRealPath,
    "installRoot",
  );

  const version = readManifestString(manifest, "version");
  parseProjectVersion(version);
  const safeRunId = resolveSafeRunId(manifest, runId);
  const releasesDir = path.resolve(installRootRealPath, "releases");
  const stagingRoot = path.resolve(installRootRealPath, "shared", "staging");
  const releasesRealPath = await resolveExistingDirectoryRealPath(
    releasesDir,
    installRootRealPath,
    "releases",
  );
  const stagingRealPath = await resolveExistingDirectoryRealPath(
    stagingRoot,
    installRootRealPath,
    "shared/staging",
  );
  const releaseDir = path.resolve(releasesRealPath, version);
  const installingDir = path.resolve(releasesRealPath, `.installing-${safeRunId}`);
  const currentPath = path.resolve(installRootRealPath, "current");
  const stageDir = path.resolve(stagingRealPath, safeRunId, "stage");
  assertInsideInstallRoot(releaseDir, releasesRealPath);
  assertInsideInstallRoot(installingDir, releasesRealPath);
  assertInsideInstallRoot(stageDir, stagingRealPath);
  const current = await assertCurrentPathInsideReleases(currentPath, releasesRealPath);
  const releaseState = await readReleaseDestinationState(
    releaseDir,
    releasesRealPath,
  );

  return {
    installRoot: installRootRealPath,
    version,
    runId: safeRunId,
    releasesDir: releasesRealPath,
    releaseDir,
    installingDir,
    currentPath,
    current,
    stagingRoot: stagingRealPath,
    stageDir,
    releaseState,
  };
}

/**
 * 安装已验证 staged bundle 到 releases/<version>。
 * @param {object} input 输入。
 * @param {string} input.installRoot 安装根目录。
 * @param {Record<string, unknown>} input.manifest detached manifest。
 * @param {string | undefined} input.runId 执行 ID。
 * @param {object} input.stageResult stageArtifact 返回值。
 * @param {string | undefined} input.expectedPlatform 期望平台。
 * @returns {Promise<object>} 安装摘要。
 */
export async function installStagedRelease({
  installRoot,
  manifest,
  runId,
  stageResult,
  expectedPlatform = supportedPlatform,
}) {
  const releasePaths = await resolveReleasePaths({ installRoot, manifest, runId });
  const staged = await assertStageArtifactBundleDir(
    stageResult,
    releasePaths.stageDir,
    releasePaths.stagingRoot,
  );

  try {
    await cleanupInstallingRelease(
      releasePaths.installingDir,
      releasePaths.releasesDir,
    );
    await cp(staged.bundleRealPath, releasePaths.installingDir, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
    });
    await resolveExistingDirectoryRealPath(
      releasePaths.installingDir,
      releasePaths.releasesDir,
      "releases/.installing-<run-id>",
    );
    await verifyReleaseBundle({
      bundleDir: releasePaths.installingDir,
      manifest,
      expectedPlatform,
    });
    await removeEmptyReleaseDestination(releasePaths.releaseState);
    await rename(releasePaths.installingDir, releasePaths.releaseDir);
    await resolveExistingDirectoryRealPath(
      releasePaths.releaseDir,
      releasePaths.releasesDir,
      "releases/<version>",
    );
    return {
      installed: true,
      version: releasePaths.version,
      runId: releasePaths.runId,
      sourceBundleDir: staged.bundleDir,
      stagingDir: releasePaths.stageDir,
      releaseDir: releasePaths.releaseDir,
      temporaryDir: releasePaths.installingDir,
      currentPath: releasePaths.currentPath,
      preservedPaths: [
        "current",
        "releases",
        "shared/staging",
        "shared/updater.lock",
      ],
      safety: {
        cleanupOnFailure: "releases/.installing-<run-id>",
        switchesCurrent: false,
        callsSystemctl: false,
      },
    };
  } catch (error) {
    await cleanupInstallingRelease(
      releasePaths.installingDir,
      releasePaths.releasesDir,
    );
    throw error;
  }
}

/**
 * 判断 systemd scope 名称是否包含禁入边界。
 * @param {string} value scope 名称。
 * @returns {boolean} 是否禁入。
 */
function hasForbiddenRuntimeScope(value) {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .some((token) => forbiddenRuntimeScopeTokens.has(token));
}

/**
 * 读取 manifest 中的 systemd 单元列表。
 * @param {Record<string, unknown>} manifest manifest。
 * @returns {Array<{ name: string, unit: string }>} service 与 unit。
 */
function readSystemdUnitsFromManifest(manifest) {
  const services = assertObject(manifest.services, "manifest.services");
  return Object.entries(services).map(([name, value]) => {
    const service = assertObject(value, `manifest.services.${name}`);
    const unit = service.systemd_unit;
    assert(
      typeof unit === "string" && unit.length > 0,
      `manifest service ${name} must declare systemd_unit`,
    );
    return { name, unit };
  });
}

/**
 * 校验 apply/update 只允许 GPT2Image-Pro web 与 proxy 服务。
 * @param {Record<string, unknown>} manifest manifest。
 * @returns {Array<{ name: string, unit: string }>} 已排序允许单元。
 */
export function assertAllowedSystemdUnits(manifest) {
  const allowed = new Set(ALLOWED_SYSTEMD_UNITS);
  const units = readSystemdUnitsFromManifest(manifest);
  const uniqueUnits = new Set(units.map((service) => service.unit));
  assert(
    units.length === ALLOWED_SYSTEMD_UNITS.length &&
      uniqueUnits.size === ALLOWED_SYSTEMD_UNITS.length,
    "manifest services must only include gpt2image-web.service and gpt2image-chatgpt-web-proxy.service",
  );
  for (const { name, unit } of units) {
    assert(!hasForbiddenRuntimeScope(name), `forbidden runtime scope rejected: ${name}`);
    assert(!hasForbiddenRuntimeScope(unit), `forbidden systemd unit rejected: ${unit}`);
    assert(allowed.has(unit), `systemd unit is not allowed: ${unit}`);
  }
  return units.sort((left, right) => {
    return ALLOWED_SYSTEMD_UNITS.indexOf(left.unit) - ALLOWED_SYSTEMD_UNITS.indexOf(right.unit);
  });
}

/**
 * 读取 current 指针摘要，不返回 env 或 secrets。
 * @param {string} installRoot 安装根目录。
 * @returns {Promise<object>} current 摘要。
 */
async function readCurrentSummary(installRoot) {
  const currentPath = resolveCurrentPath(installRoot);
  if (!(await pathExists(currentPath))) {
    return { path: currentPath, exists: false };
  }

  const currentStat = await lstat(currentPath);
  const summary = {
    path: currentPath,
    exists: true,
    type: currentStat.isSymbolicLink()
      ? "symlink"
      : currentStat.isDirectory()
        ? "directory"
        : "other",
    manifest: await readOptionalManifestSummary(path.join(currentPath, "manifest.json")),
  };
  if (currentStat.isSymbolicLink()) {
    const target = await readlink(currentPath);
    const resolvedTarget = path.resolve(path.dirname(currentPath), target);
    summary.target = target;
    summary.resolvedTarget = resolvedTarget;
    summary.targetInsideReleases = true;
    try {
      assertInsideInstallRoot(resolvedTarget, resolveReleasesRoot(installRoot));
    } catch {
      summary.targetInsideReleases = false;
    }
  }
  return summary;
}

/**
 * 读取目录存在性摘要。
 * @param {string} directoryPath 目录路径。
 * @returns {Promise<{ path: string, exists: boolean, entries?: string[] }>} 目录摘要。
 */
async function readDirectorySummary(directoryPath) {
  if (!(await pathExists(directoryPath))) {
    return { path: directoryPath, exists: false };
  }
  const entries = await readdir(directoryPath);
  return {
    path: directoryPath,
    exists: true,
    entries: entries.slice(0, 20),
  };
}

/**
 * 读取目录可写性摘要，不创建或删除文件。
 * @param {string} directoryPath 目录路径。
 * @returns {Promise<{ path: string, exists: boolean, writable: boolean, error?: string }>} 可写性摘要。
 */
async function readWritableDirectorySummary(directoryPath) {
  if (!(await pathExists(directoryPath))) {
    return { path: directoryPath, exists: false, writable: false };
  }
  try {
    await access(directoryPath, fsConstants.W_OK);
    return { path: directoryPath, exists: true, writable: true };
  } catch (error) {
    return {
      path: directoryPath,
      exists: true,
      writable: false,
      error: redactSensitiveText(error instanceof Error ? error.message : String(error)),
    };
  }
}

/**
 * 读取 updater lock 占用状态。
 * @param {string} installRoot 安装根目录。
 * @returns {Promise<{ path: string, occupied: boolean }>} lock 状态。
 */
async function readUpdateLockSummary(installRoot) {
  const lockPath = resolveLockPath(installRoot);
  const occupied = await pathExists(lockPath);
  let metadata = null;
  if (occupied) {
    metadata = await readOptionalJsonSummary(path.join(lockPath, "metadata.json"));
  }
  return {
    path: lockPath,
    occupied,
    metadata,
    staleLockHint: occupied
      ? "stale lock must be inspected manually; do not auto-delete shared/updater.lock"
      : null,
  };
}

/**
 * 构造磁盘空间检查命令边界，只描述不执行。
 * @param {string} installRoot 安装根目录。
 * @returns {object} 命令边界。
 */
function buildDiskSpaceCommandBoundary(installRoot) {
  return {
    command: "df",
    args: ["-Pk", installRoot],
    executed: false,
    purpose: "check free space before writing releases/<version>",
  };
}

/**
 * 构造 systemd status 查询计划，只描述允许单元不调用 systemctl。
 * @param {Array<{ name: string, unit: string }>} units 允许单元。
 * @returns {object[]} 查询计划。
 */
function buildServiceStatusPlan(units) {
  return units.map(({ name, unit }) => ({
    service: name,
    unit,
    command: "systemctl",
    args: ["is-active", "--quiet", unit],
    executed: false,
  }));
}

/**
 * 构造数据库连接检查命令边界，只验证 env 文件与命令形状。
 * @param {object} input 输入。
 * @param {string} input.installRoot 安装根目录。
 * @param {string} input.envFile env 文件。
 * @param {Record<string, unknown>} input.manifest manifest。
 * @returns {object} 命令边界。
 */
function buildDatabaseConnectivityCommandBoundary({ installRoot, envFile, manifest }) {
  const version = readManifestString(manifest, "version");
  return {
    command: "node",
    args: [
      path.join(resolveReleasesRoot(installRoot), version, "scripts", "database-connectivity-check.mjs"),
    ],
    envFile,
    executed: false,
    sensitiveInputsRedacted: true,
    purpose: "verify DATABASE_URL connectivity before migration",
  };
}

/**
 * 执行 apply/update 的只预检运行态模型，不安装、不切换、不重启。
 * @param {object} input 输入。
 * @param {string} input.installRoot 安装根目录。
 * @param {Record<string, unknown>} input.manifest manifest。
 * @param {string} input.envFile env 文件。
 * @returns {Promise<object>} 预检摘要。
 */
export async function preflightApplyRuntime({ installRoot, manifest, envFile }) {
  const absoluteInstallRoot = path.resolve(installRoot);
  const absoluteEnvFile = path.resolve(envFile);
  const releasesDir = resolveReleasesRoot(absoluteInstallRoot);
  const stagingRoot = resolveStagingRoot(absoluteInstallRoot);
  const current = await readCurrentSummary(absoluteInstallRoot);
  const releases = await readDirectorySummary(releasesDir);
  const staging = await readWritableDirectorySummary(stagingRoot);
  const lock = await readUpdateLockSummary(absoluteInstallRoot);
  const allowedUnits = assertAllowedSystemdUnits(manifest);
  const env = await preflightRuntimeEnv({
    envFile: absoluteEnvFile,
    requiredNames: requiredApplyEnvNames,
  });

  assert(releases.exists, `releases directory not found: ${releasesDir}`);
  assert(staging.exists, `shared/staging directory not found: ${stagingRoot}`);
  assert(staging.writable, `shared/staging is not writable: ${stagingRoot}`);
  assert(!lock.occupied, `shared/updater.lock is occupied: ${lock.path}`);

  return {
    installRoot: absoluteInstallRoot,
    paths: {
      current,
      releases,
      staging,
      lock,
    },
    env,
    safety: {
      allowedSystemdUnits: ALLOWED_SYSTEMD_UNITS,
      forbiddenScopes: ["PostgreSQL", "Nginx", "Docker", "Admin", "UOL", "UI"],
      writesReleasesVersion: false,
      switchesCurrent: false,
      callsSystemctl: false,
    },
    commandBoundaries: {
      diskSpace: buildDiskSpaceCommandBoundary(absoluteInstallRoot),
      databaseConnectivity: buildDatabaseConnectivityCommandBoundary({
        installRoot: absoluteInstallRoot,
        envFile: absoluteEnvFile,
        manifest,
      }),
      serviceStatus: buildServiceStatusPlan(allowedUnits),
    },
  };
}

/**
 * 构造 check/plan 共用的白名单摘要。
 * @param {Record<string, unknown>} manifest manifest。
 * @param {string | undefined} currentVersion 当前版本。
 * @returns {object} 非敏感摘要。
 */
function buildCheckSummary(manifest, currentVersion) {
  const availableVersion = readManifestString(manifest, "version");
  const minimumSupportedVersion = readManifestString(
    manifest,
    "minimum_supported_version",
  );
  const artifactUrl = readManifestString(manifest, "artifact_url");
  const artifactSha256 = readManifestString(manifest, "artifact_sha256");
  const decision = decideUpdate({
    currentVersion,
    availableVersion,
    minimumSupportedVersion,
  });

  return {
    current_version: currentVersion ?? null,
    available_version: availableVersion,
    minimum_supported_version: minimumSupportedVersion,
    decision: decision.decision,
    reason: decision.reason,
    artifact_url: artifactUrl,
    artifact_sha256: artifactSha256,
  };
}

/**
 * 校验 manifest。
 * @param {Map<string, string | boolean>} args 参数映射。
 * @returns {Promise<object>} 校验摘要。
 */
export async function runCheck(args) {
  assertReadOnlyBoundary();
  const manifestSource = requireManifestSourceArg(args);
  const expectedPlatform = readStringArg(args, "platform") ?? supportedPlatform;
  await verifySchemaBaseline();
  const { source, manifest } = await readManifestSource(manifestSource);
  verifyManifest(manifest, expectedPlatform);
  const currentVersion = await resolveCurrentVersion(args);
  return {
    command: "check",
    dryRun: true,
    manifest: source,
    platform: manifest.platform,
    ok: true,
    ...buildCheckSummary(manifest, currentVersion),
  };
}

/**
 * 生成只读更新计划。
 * @param {Map<string, string | boolean>} args 参数映射。
 * @param {"plan" | "dry-run"} command 命令名。
 * @returns {Promise<object>} 计划摘要。
 */
export async function runPlan(args, command = "plan") {
  assertReadOnlyBoundary();
  const installRoot = resolveInstallRoot(args);
  const check = await runCheck(args);
  const status = await readInstallStatus(installRoot);
  return {
    command,
    dryRun: true,
    installRoot,
    manifest: check.manifest,
    current_version: check.current_version,
    available_version: check.available_version,
    minimum_supported_version: check.minimum_supported_version,
    decision: check.decision,
    reason: check.reason,
    artifact_url: check.artifact_url,
    artifact_sha256: check.artifact_sha256,
    status_current_version: readCurrentVersionFromStatus(status) ?? null,
    steps: [
      "validate manifest",
      "inspect install root status",
      "plan staging directory",
      "stop before migrations/current switch/systemd restart",
    ],
    blockedOperations: [
      "download artifact",
      "write releases/current",
      "run migrations",
      "restart systemd services",
      "healthcheck rollback",
    ],
  };
}

/**
 * 断言子路径位于父路径内。
 * @param {string} child 子路径。
 * @param {string} parent 父路径。
 * @returns {void} 无返回。
 */
export function assertInsideInstallRoot(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  assert(
    relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)),
    `${child} is outside ${parent}`,
  );
}

/**
 * 从 manifest artifact_url 提取 artifact 文件名。
 * @param {Record<string, unknown>} manifest manifest。
 * @returns {string} 文件名。
 */
function readArtifactFileName(manifest) {
  const artifactUrl = readManifestString(manifest, "artifact_url");
  const artifactPath = new URL(artifactUrl).pathname;
  const fileName = path.posix.basename(artifactPath);
  validateArtifactFileName(fileName, manifest);
  return fileName;
}

/**
 * 校验 artifact 文件名包含版本和平台。
 * @param {string} fileName 文件名。
 * @param {Record<string, unknown>} manifest manifest。
 * @returns {void} 无返回。
 */
export function validateArtifactFileName(fileName, manifest) {
  const version = readManifestString(manifest, "version");
  assert(fileName === path.basename(fileName), "artifact filename must be a basename");
  assert(fileName.includes(version), "artifact filename must include manifest version");
  assert(fileName.includes(supportedPlatform), "artifact filename must include linux-x64");
  assert(
    fileName.endsWith(".tar.gz") || fileName.endsWith(".zip"),
    "artifact filename must end with .tar.gz or .zip",
  );
}

/**
 * 解析下载目标路径。
 * @param {object} input 输入。
 * @param {string} input.installRoot 安装根目录。
 * @param {Record<string, unknown>} input.manifest manifest。
 * @param {string | undefined} input.runId 执行 ID。
 * @returns {{ downloadsDir: string, artifactPath: string }} 下载目录与 artifact 路径。
 */
export function resolveDownloadTarget({ installRoot, manifest, runId }) {
  const absoluteInstallRoot = path.resolve(installRoot);
  const safeRunId = resolveSafeRunId(manifest, runId);
  const stagingRoot = path.join(absoluteInstallRoot, "shared", "staging");
  const downloadsDir = path.join(stagingRoot, safeRunId, "downloads");
  const artifactPath = path.join(downloadsDir, readArtifactFileName(manifest));
  assertInsideInstallRoot(downloadsDir, stagingRoot);
  assertInsideInstallRoot(artifactPath, downloadsDir);
  return { downloadsDir, artifactPath };
}

/**
 * 判断来源是否是 HTTPS URL。
 * @param {string} source 来源。
 * @returns {boolean} 是否 HTTPS。
 */
function isHttpsSource(source) {
  return source.startsWith("https://");
}

/**
 * 判断来源是否是 file URL。
 * @param {string} source 来源。
 * @returns {boolean} 是否 file URL。
 */
function isFileSource(source) {
  return source.startsWith("file://");
}

/**
 * 下载或复制文件到 .partial，然后原子 rename 到最终路径。
 * @param {string} source 本地路径、file URL 或 HTTPS URL。
 * @param {string} targetPath 目标路径。
 * @param {{ fetch?: Function }} options 注入项。
 * @returns {Promise<string>} 最终路径。
 */
export async function downloadToPartial(source, targetPath, options = {}) {
  const partialPath = `${targetPath}.partial`;
  await mkdir(path.dirname(targetPath), { recursive: true });
  await rm(partialPath, { force: true });
  try {
    if (isHttpsSource(source)) {
      const fetchImpl = options.fetch ?? globalThis.fetch;
      assert(typeof fetchImpl === "function", "https artifact fetch is not available");
      const response = await fetchImpl(source, { method: "GET", redirect: "follow" });
      assert(
        response && response.ok === true,
        `artifact fetch failed: ${response?.status ?? "unknown"} ${response?.statusText ?? ""}`.trim(),
      );
      assert(response.body, "artifact fetch response has no body");
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partialPath));
    } else {
      const sourcePath = isFileSource(source) ? fileURLToPath(source) : path.resolve(source);
      await copyFile(sourcePath, partialPath);
    }
    await rename(partialPath, targetPath);
    return targetPath;
  } catch (error) {
    await rm(partialPath, { force: true });
    throw error;
  }
}

/**
 * 解析 detached checksum 文件。
 * @param {string} checksumFile checksum 文件路径。
 * @returns {Promise<{ hash: string, fileName: string }>} checksum 条目。
 */
async function readDetachedChecksum(checksumFile) {
  const text = (await readFile(checksumFile, "utf8")).trim();
  const match = /^([0-9a-fA-F]{64})\s+(.+)$/.exec(text);
  assert(Boolean(match), "checksum file has invalid format");
  return {
    hash: match[1].toLowerCase(),
    fileName: path.basename(match[2].replace(/\\/g, "/")),
  };
}

/**
 * 校验已下载 artifact。
 * @param {object} input 输入。
 * @param {string} input.artifactPath artifact 路径。
 * @param {Record<string, unknown>} input.manifest manifest。
 * @param {string | undefined} input.checksumFile checksum 文件。
 * @returns {Promise<object>} 校验摘要。
 */
export async function verifyDownloadedArtifact({ artifactPath, manifest, checksumFile }) {
  const fileName = path.basename(artifactPath);
  validateArtifactFileName(fileName, manifest);
  await verifyArtifact(artifactPath, manifest);
  const actualSha256 = await sha256File(artifactPath);
  if (checksumFile) {
    const checksum = await readDetachedChecksum(checksumFile);
    assert(checksum.fileName === fileName, "checksum filename mismatch");
    assert(checksum.hash === actualSha256, "checksum sha256 mismatch");
    assert(
      checksum.hash === readManifestString(manifest, "artifact_sha256").toLowerCase(),
      "checksum does not match manifest artifact_sha256",
    );
  }
  return { artifactPath, fileName, sha256: actualSha256 };
}

/**
 * 下载 artifact 到 staging downloads 目录并校验。
 * @param {object} input 输入。
 * @param {string} input.installRoot 安装根目录。
 * @param {Record<string, unknown>} input.manifest manifest。
 * @param {string | undefined} input.artifactFile 本地 artifact fixture。
 * @param {string | undefined} input.checksumFile detached checksum。
 * @param {string | undefined} input.runId 执行 ID。
 * @param {Function | undefined} input.fetch fetch 注入。
 * @returns {Promise<object>} 下载摘要。
 */
export async function downloadArtifact({
  installRoot,
  manifest,
  artifactFile,
  checksumFile,
  runId,
  fetch,
}) {
  const { artifactPath } = resolveDownloadTarget({ installRoot, manifest, runId });
  const source = artifactFile ?? readManifestString(manifest, "artifact_url");
  await downloadToPartial(source, artifactPath, { fetch });
  try {
    return await verifyDownloadedArtifact({ artifactPath, manifest, checksumFile });
  } catch (error) {
    await rm(artifactPath, { force: true });
    throw error;
  }
}

/**
 * 执行 download 命令。
 * @param {Map<string, string | boolean>} args 参数映射。
 * @returns {Promise<object>} 下载摘要。
 */
async function runDownload(args) {
  const manifestSource = requireManifestSourceArg(args);
  await verifySchemaBaseline();
  const { manifest } = await readManifestSource(manifestSource);
  verifyManifest(manifest, readStringArg(args, "platform") ?? supportedPlatform);
  const installRoot = resolveInstallRoot(args);
  const result = await downloadArtifact({
    installRoot,
    manifest,
    artifactFile: readStringArg(args, "artifact-file"),
    checksumFile: readStringArg(args, "checksum-file"),
    runId: readStringArg(args, "run-id"),
  });
  return { command: "download", dryRun: false, installRoot, ...result };
}

/**
 * 获取 staging 根目录。
 * @param {string} installRoot 安装根目录。
 * @returns {string} staging 根目录。
 */
function resolveStagingRoot(installRoot) {
  return path.join(path.resolve(installRoot), "shared", "staging");
}

/**
 * 获取 updater lock 路径。
 * @param {string} installRoot 安装根目录。
 * @returns {string} lock 路径。
 */
function resolveLockPath(installRoot) {
  return path.join(path.resolve(installRoot), "shared", "updater.lock");
}

/**
 * 获取安全 run id。
 * @param {Record<string, unknown>} manifest manifest。
 * @param {string | undefined} runId 传入的 run id。
 * @returns {string} 安全 run id。
 */
function resolveSafeRunId(manifest, runId) {
  const version = readManifestString(manifest, "version");
  const safeRunId = runId ?? version;
  assert(safeRunId.length > 0, "run-id must not be empty");
  assert(!safeRunId.includes(".."), "run-id must not contain path traversal");
  assert(!path.isAbsolute(safeRunId), "run-id must be relative");
  assert(!/^[a-zA-Z]:[\\/]/.test(safeRunId), "run-id must not be a drive path");
  assert(
    !safeRunId.includes("/") && !safeRunId.includes("\\"),
    "run-id must be a single path segment",
  );
  assert(
    /^[A-Za-z0-9._-]+$/.test(safeRunId),
    "run-id must contain only letters, digits, dot, underscore, or dash",
  );
  return safeRunId;
}

/**
 * 获取原子更新锁。
 * @param {string} installRoot 安装根目录。
 * @returns {Promise<{ lockPath: string }>} lock 句柄。
 */
export async function acquireUpdateLock(installRoot) {
  const lockPath = resolveLockPath(installRoot);
  await mkdir(path.dirname(lockPath), { recursive: true });
  try {
    await mkdir(lockPath);
  } catch (error) {
    throw new Error(`updater lock is held: ${lockPath}`);
  }
  await writeFile(
    path.join(lockPath, "metadata.json"),
    `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }, null, 2)}
`,
  );
  return { lockPath };
}

/**
 * 释放更新锁。
 * @param {{ lockPath: string }} lock lock 句柄。
 * @returns {Promise<void>} 无返回。
 */
export async function releaseUpdateLock(lock) {
  await rm(lock.lockPath, { recursive: true, force: true });
}

/**
 * 校验 archive entry 不会路径穿越。
 * @param {string} entry archive entry。
 * @returns {string} 归一化 entry。
 */
export function assertSafeArchiveEntry(entry) {
  const normalized = entry.replace(/\\/g, "/");
  assert(normalized.length > 0, "archive entry must not be empty");
  assert(!normalized.startsWith("/"), "archive entry must not be absolute");
  assert(!/^[a-zA-Z]:\//.test(normalized), "archive entry must not use drive prefix");
  assert(
    !normalized.split("/").includes(".."),
    "archive entry path traversal is not allowed",
  );
  return normalized;
}

/**
 * 获取 tar 参数。
 * @param {string} artifactPath artifact 路径。
 * @param {"list" | "extract"} mode 模式。
 * @param {string | undefined} targetDir 目标目录。
 * @returns {string[]} tar 参数。
 */
function buildTarArgs(artifactPath, mode, targetDir) {
  const isGzip = artifactPath.endsWith(".tar.gz") || artifactPath.endsWith(".tgz");
  if (mode === "list") {
    return isGzip ? ["-tzf", artifactPath] : ["-tf", artifactPath];
  }
  return isGzip
    ? ["-xzf", artifactPath, "-C", targetDir]
    : ["-xf", artifactPath, "-C", targetDir];
}

/**
 * 列出 archive entries。
 * @param {string} artifactPath artifact 路径。
 * @returns {string[]} entries。
 */
function listArchiveEntries(artifactPath) {
  const result = spawnSync("tar", buildTarArgs(artifactPath, "list"), {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`tar list failed: ${result.stderr || result.stdout}`.trim());
  }
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(assertSafeArchiveEntry);
}

/**
 * 解包 artifact 到 staging 目录。
 * @param {string} artifactPath artifact 路径。
 * @param {string} stagingDir staging 目录。
 * @returns {Promise<string[]>} entries。
 */
export async function extractArchiveToStaging(artifactPath, stagingDir) {
  const entries = listArchiveEntries(artifactPath);
  await mkdir(stagingDir, { recursive: true });
  const result = spawnSync("tar", buildTarArgs(artifactPath, "extract", stagingDir), {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`tar extract failed: ${result.stderr || result.stdout}`.trim());
  }
  return entries;
}

/**
 * 查找解包后的 bundle 根目录。
 * @param {string} stagingDir staging 目录。
 * @returns {Promise<string>} bundle 根目录。
 */
async function findStagedBundleDir(stagingDir) {
  const entries = await readdir(stagingDir, { withFileTypes: true });
  const directories = entries.filter((entry) => entry.isDirectory());
  if (directories.length === 1) {
    return path.join(stagingDir, directories[0].name);
  }
  return stagingDir;
}

/**
 * 解析 env 文件中的变量名，不返回变量值。
 * @param {string} text env 文件文本。
 * @returns {Set<string>} 变量名集合。
 */
function parseEnvVariableNames(text) {
  const names = new Set();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const assignment = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length).trim()
      : trimmed;
    const separatorIndex = assignment.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const name = assignment.slice(0, separatorIndex).trim();
    if (/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      names.add(name);
    }
  }
  return names;
}

/**
 * 运行 env 文件预检。
 * @param {object} input 输入。
 * @param {string | undefined} input.envFile env 文件。
 * @param {string[]} input.requiredNames 必需变量名。
 * @returns {Promise<object>} 预检摘要。
 */
export async function preflightRuntimeEnv({
  envFile = defaultRuntimeEnvFile,
  requiredNames = requiredRuntimeEnvNames,
}) {
  const absoluteEnvFile = path.resolve(envFile);
  assert(await pathExists(absoluteEnvFile), `env-file not found: ${absoluteEnvFile}`);
  const names = parseEnvVariableNames(await readFile(absoluteEnvFile, "utf8"));
  const missingNames = requiredNames.filter((name) => !names.has(name));
  assert(
    missingNames.length === 0,
    `env-file missing required names: ${missingNames.join(", ")}`,
  );
  return {
    envFile: absoluteEnvFile,
    requiredNames,
    checked: true,
    valuesReturned: false,
  };
}

/**
 * 解包并验证 artifact 到 shared/staging。
 * @param {object} input 输入。
 * @param {string} input.installRoot 安装根目录。
 * @param {string} input.artifactPath artifact 路径。
 * @param {Record<string, unknown>} input.manifest manifest。
 * @param {string | undefined} input.runId 执行 ID。
 * @param {string | undefined} input.envFile env 文件。
 * @returns {Promise<object>} stage 摘要。
 */
export async function stageArtifact({ installRoot, artifactPath, manifest, runId, envFile }) {
  const absoluteInstallRoot = path.resolve(installRoot);
  const stagingRoot = resolveStagingRoot(absoluteInstallRoot);
  const safeRunId = resolveSafeRunId(manifest, runId);
  const stagingDir = path.join(stagingRoot, safeRunId, "stage");
  assertInsideInstallRoot(stagingDir, stagingRoot);
  await verifyArtifact(artifactPath, manifest);
  await rm(stagingDir, { recursive: true, force: true });
  await extractArchiveToStaging(artifactPath, stagingDir);
  const bundleDir = await findStagedBundleDir(stagingDir);
  assertInsideInstallRoot(bundleDir, stagingDir);
  await verifyRequiredPaths(bundleDir);
  await verifyDeniedPaths(bundleDir);
  await verifySha256Sums(bundleDir);
  const env = await preflightRuntimeEnv({ envFile });
  return { stagingDir, bundleDir, env };
}

/**
 * 执行 stage 命令。
 * @param {Map<string, string | boolean>} args 参数映射。
 * @returns {Promise<object>} stage 摘要。
 */
async function runStage(args) {
  const manifestSource = requireManifestSourceArg(args);
  await verifySchemaBaseline();
  const { manifest } = await readManifestSource(manifestSource);
  verifyManifest(manifest, readStringArg(args, "platform") ?? supportedPlatform);
  const installRoot = resolveInstallRoot(args);
  const artifactPath = readStringArg(args, "artifact-file");
  assert(Boolean(artifactPath), "--artifact-file is required");
  const lock = await acquireUpdateLock(installRoot);
  try {
    const result = await stageArtifact({
      installRoot,
      artifactPath: path.resolve(artifactPath),
      manifest,
      runId: readStringArg(args, "run-id"),
      envFile: readStringArg(args, "env-file"),
    });
    return { command: "stage", installRoot, lockPath: lock.lockPath, ...result };
  } finally {
    await releaseUpdateLock(lock);
  }
}

/**
 * 解析 EnvironmentFile 中的值，供真实迁移子进程使用；返回值只能进入子进程 env，不能直接写日志。
 * @param {string} rawValue 原始值。
 * @returns {string} 解析后的值。
 */
function parseRuntimeEnvValue(rawValue) {
  const value = rawValue.trim();
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * 读取运行态 env 文件值并校验必需变量；调用方必须避免把 values 写入日志。
 * @param {string} envFile env 文件路径。
 * @param {string[]} requiredNames 必需变量名。
 * @returns {Promise<{ envFile: string, values: Record<string, string> }>} env 值。
 */
async function readRuntimeEnvValues(envFile, requiredNames) {
  const absoluteEnvFile = path.resolve(envFile);
  assert(await pathExists(absoluteEnvFile), `env-file not found: ${absoluteEnvFile}`);
  const values = {};
  const text = await readFile(absoluteEnvFile, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const assignment = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length).trim()
      : trimmed;
    const separatorIndex = assignment.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }
    const name = assignment.slice(0, separatorIndex).trim();
    if (/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      values[name] = parseRuntimeEnvValue(assignment.slice(separatorIndex + 1));
    }
  }

  const missingNames = requiredNames.filter((name) => !Object.hasOwn(values, name));
  assert(
    missingNames.length === 0,
    `env-file missing required names: ${missingNames.join(", ")}`,
  );
  return { envFile: absoluteEnvFile, values };
}

/**
 * 默认迁移命令 runner；不经 shell，避免命令注入并便于 self-test 注入替身。
 * @param {string} command 命令。
 * @param {string[]} args 参数。
 * @param {{ cwd: string, env: Record<string, string | undefined> }} options 运行选项。
 * @returns {{ status: number | null, signal: string | null, stdout: string, stderr: string, error?: Error }} 结果。
 */
function defaultMigrationRunner(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

/**
 * 将命令结果脱敏成可落盘结构。
 * @param {object} result runner 原始结果。
 * @returns {object} 脱敏结果。
 */
function sanitizeMigrationResult(result) {
  const status = typeof result.status === "number" ? result.status : null;
  const signal = typeof result.signal === "string" ? result.signal : null;
  const error =
    result.error instanceof Error
      ? result.error.message
      : result.error
        ? String(result.error)
        : null;
  return {
    exitCode: status,
    signal,
    stdout: redactSensitiveText(result.stdout ?? ""),
    stderr: redactSensitiveText(result.stderr ?? ""),
    error: error ? redactSensitiveText(error) : null,
  };
}

/**
 * 追加 updater 结构化日志；日志写入前再次统一脱敏。
 * @param {string} logPath 日志路径。
 * @param {Record<string, unknown>} entry 日志条目。
 * @returns {Promise<void>} 无返回。
 */
async function appendUpdaterLog(logPath, entry) {
  await mkdir(path.dirname(logPath), { recursive: true });
  await appendFile(
    logPath,
    `${redactSensitiveText(JSON.stringify(entry, null, 0))}\n`,
  );
}

/**
 * 写入 apply 进度文件。
 * @param {string} applyJsonPath shared/staging/<run-id>/apply.json。
 * @param {Record<string, unknown>} data 进度数据。
 * @returns {Promise<void>} 无返回。
 */
async function writeApplyProgress(applyJsonPath, data) {
  await mkdir(path.dirname(applyJsonPath), { recursive: true });
  await writeFile(
    applyJsonPath,
    `${redactSensitiveText(JSON.stringify(data, null, 2))}\n`,
  );
}

/**
 * 解析已安装 candidate release 的 migrator 路径，确保它来自 releases/<version>/migrator 且未通过 current 指针运行。
 * @param {object} input 输入。
 * @param {string} input.installRoot 安装根目录。
 * @param {Record<string, unknown>} input.manifest manifest。
 * @returns {Promise<object>} candidate 路径摘要。
 */
async function resolveCandidateMigrationPaths({ installRoot, manifest }) {
  const absoluteInstallRoot = path.resolve(installRoot);
  const installRootStat = await lstat(absoluteInstallRoot);
  assert(
    installRootStat.isDirectory() || installRootStat.isSymbolicLink(),
    "installRoot must be a directory",
  );
  const installRootRealPath = await realpath(absoluteInstallRoot);
  const releasesDir = await resolveExistingDirectoryRealPath(
    path.join(installRootRealPath, "releases"),
    installRootRealPath,
    "releases",
  );
  const stagingRoot = await resolveExistingDirectoryRealPath(
    path.join(installRootRealPath, "shared", "staging"),
    installRootRealPath,
    "shared/staging",
  );
  const version = readManifestString(manifest, "version");
  parseProjectVersion(version);
  const releaseDir = await resolveExistingDirectoryRealPath(
    path.join(releasesDir, version),
    releasesDir,
    "releases/<version>",
  );
  const migratorDir = await resolveExistingDirectoryRealPath(
    path.join(releaseDir, "migrator"),
    releaseDir,
    "releases/<version>/migrator",
  );
  const currentPath = path.join(installRootRealPath, "current");
  const currentStat = await lstatIfExists(currentPath);
  if (currentStat) {
    const currentRealPath = await realpath(currentPath);
    assert(
      currentRealPath !== releaseDir,
      "DB migration must run before current is switched to candidate release",
    );
  }
  return {
    installRoot: installRootRealPath,
    releasesDir,
    stagingRoot,
    releaseDir,
    migratorDir,
    currentPath,
    version,
  };
}

/**
 * 构造 candidate migrator 命令列表，cwd 固定为 releases/<version>/migrator。
 * @param {string} migratorDir migrator cwd。
 * @returns {Array<{ name: string, command: string, args: string[], cwd: string, purpose: string }>} 命令。
 */
function buildCandidateMigrationCommands(migratorDir) {
  return [
    {
      name: "corepack-enable",
      command: "corepack",
      args: ["enable"],
      cwd: migratorDir,
      purpose: "prepare pnpm from candidate releases/<version>/migrator",
    },
    {
      name: "database-migrate",
      command: "pnpm",
      args: ["--dir", "packages/database", "db:migrate"],
      cwd: migratorDir,
      purpose:
        "run pnpm --dir packages/database db:migrate from releases/<version>/migrator before current switch",
    },
  ];
}

/**
 * 执行 candidate release 的 pre_switch 数据库迁移；失败时抛错，调用方不得切 current 或重启服务。
 * @param {object} input 输入。
 * @param {string} input.installRoot 安装根目录。
 * @param {Record<string, unknown>} input.manifest manifest。
 * @param {string | undefined} input.runId 执行 ID。
 * @param {string} input.envFile env 文件。
 * @param {object | null | undefined} input.previousCurrent 切换前 current 摘要。
 * @param {Function | undefined} input.runner 可注入命令 runner。
 * @param {string | undefined} input.logPath updater 日志路径。
 * @returns {Promise<object>} 迁移摘要。
 */
export async function runCandidateMigration({
  installRoot,
  manifest,
  runId,
  envFile,
  previousCurrent = null,
  runner = defaultMigrationRunner,
  logPath = defaultUpdaterLogPath,
}) {
  assert(
    manifest.migration_mode === "pre_switch",
    "DB migration must use pre_switch mode before current switch",
  );
  const paths = await resolveCandidateMigrationPaths({ installRoot, manifest });
  const safeRunId = resolveSafeRunId(manifest, runId);
  const applyJsonPath = path.join(paths.stagingRoot, safeRunId, "apply.json");
  assertInsideInstallRoot(applyJsonPath, paths.stagingRoot);
  const env = await readRuntimeEnvValues(envFile, requiredApplyEnvNames);
  const startedAt = new Date().toISOString();
  const commands = buildCandidateMigrationCommands(paths.migratorDir);
  const commandResults = [];
  const baseProgress = {
    phase: "M1-P4 candidate DB migration",
    migration_mode: "pre_switch",
    migration_started_at: startedAt,
    migration_finished_at: null,
    migration_status: "running",
    candidate_release: paths.releaseDir,
    candidate_migrator: paths.migratorDir,
    current_path: paths.currentPath,
    previous_current: previousCurrent,
    apply_json: applyJsonPath,
    db_migration_irreversible: true,
    env_file: env.envFile,
    sensitive_inputs_redacted: true,
    services_not_restarted: ALLOWED_SYSTEMD_UNITS,
    safety: {
      switchesCurrentBeforeMigration: false,
      restartsSystemdBeforeMigration: false,
      touchesPostgreSQLNginxDockerAdminUolUi: false,
      rollbackScopeAfterMigration:
        "应用层仅恢复 current 和 gpt2image-web.service/gpt2image-chatgpt-web-proxy.service，数据库迁移不可自动回滚",
    },
  };

  await writeApplyProgress(applyJsonPath, {
    ...baseProgress,
    commands: commands.map(({ name, command, args, cwd, purpose }) => ({
      name,
      command,
      args,
      cwd,
      purpose,
      executed: false,
    })),
  });
  await appendUpdaterLog(logPath, {
    at: startedAt,
    event: "migration_started",
    status: "running",
    candidate_release: paths.releaseDir,
    candidate_migrator: paths.migratorDir,
    apply_json: applyJsonPath,
    db_migration_irreversible: true,
  });

  try {
    for (const spec of commands) {
      const rawResult = await runner(spec.command, spec.args, {
        cwd: spec.cwd,
        env: { ...process.env, ...env.values },
      });
      const result = sanitizeMigrationResult(rawResult);
      const record = {
        ...spec,
        executed: true,
        ...result,
      };
      commandResults.push(record);
      await appendUpdaterLog(logPath, {
        at: new Date().toISOString(),
        event: "migration_command_finished",
        command: spec.command,
        args: spec.args,
        cwd: spec.cwd,
        result,
      });
      assert(
        result.exitCode === 0 && !result.error,
        `DB migration command failed before current switch: ${spec.command} ${spec.args.join(" ")}`,
      );
    }

    const finishedAt = new Date().toISOString();
    const progress = {
      ...baseProgress,
      migration_finished_at: finishedAt,
      migration_status: "completed",
      commands: commandResults,
    };
    await writeApplyProgress(applyJsonPath, progress);
    await appendUpdaterLog(logPath, {
      at: finishedAt,
      event: "migration_finished",
      status: "completed",
      candidate_release: paths.releaseDir,
      apply_json: applyJsonPath,
      db_migration_irreversible: true,
    });
    return progress;
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const migrationError = redactSensitiveText(
      error instanceof Error ? error.message : String(error),
    );
    const progress = {
      ...baseProgress,
      migration_finished_at: finishedAt,
      migration_status: "failed",
      migration_error: migrationError,
      commands: commandResults,
    };
    await writeApplyProgress(applyJsonPath, progress);
    await appendUpdaterLog(logPath, {
      at: finishedAt,
      event: "migration_failed",
      status: "failed",
      candidate_release: paths.releaseDir,
      apply_json: applyJsonPath,
      db_migration_irreversible: true,
      error: migrationError,
    });
    throw new Error(migrationError);
  }
}

/**
 * 捕获 current 切换前的上一版指针，并验证上一版位于 releases 内。
 * @param {object} input 输入。
 * @param {string} input.installRoot 安装根目录。
 * @returns {Promise<object>} previous current 摘要。
 */
export async function capturePreviousCurrent({ installRoot }) {
  const absoluteInstallRoot = path.resolve(installRoot);
  const installRootRealPath = await realpath(absoluteInstallRoot);
  const releasesDir = await resolveExistingDirectoryRealPath(
    path.join(installRootRealPath, "releases"),
    installRootRealPath,
    "releases",
  );
  const currentPath = path.join(installRootRealPath, "current");
  const currentStat = await lstatIfExists(currentPath);
  if (!currentStat) {
    return {
      exists: false,
      currentPath,
      releaseDir: null,
      manifest: null,
    };
  }

  if (currentStat.isSymbolicLink()) {
    const target = await readlink(currentPath);
    const resolvedTarget = path.resolve(path.dirname(currentPath), target);
    assertInsideInstallRoot(resolvedTarget, releasesDir);
    const releaseDir = await realpath(resolvedTarget);
    assertInsideInstallRoot(releaseDir, releasesDir);
    return {
      exists: true,
      type: "symlink",
      currentPath,
      target,
      resolvedTarget,
      releaseDir,
      manifest: await readOptionalManifestSummary(path.join(releaseDir, "manifest.json")),
    };
  }

  assert(currentStat.isDirectory(), "current must be a symlink or directory");
  const releaseDir = await realpath(currentPath);
  assertInsideInstallRoot(releaseDir, releasesDir);
  return {
    exists: true,
    type: "directory",
    currentPath,
    releaseDir,
    manifest: await readOptionalManifestSummary(path.join(releaseDir, "manifest.json")),
  };
}

/**
 * 替换 current 指针；Linux 生产路径使用 rename 原子替换，Windows 仅允许本地 symlink fixture fallback。
 * @param {string} temporaryCurrentPath current.next 路径。
 * @param {string} currentPath current 路径。
 * @returns {Promise<object>} 替换方式摘要。
 */
async function renameCurrentPointer(temporaryCurrentPath, currentPath) {
  try {
    await rename(temporaryCurrentPath, currentPath);
    return { method: "rename", atomic: true };
  } catch (error) {
    if (process.platform !== "win32") {
      throw error;
    }
    const currentStat = await lstatIfExists(currentPath);
    assert(
      currentStat?.isSymbolicLink(),
      "Windows fallback only replaces current symlink fixtures",
    );
    await rm(currentPath, { recursive: true, force: true });
    await rename(temporaryCurrentPath, currentPath);
    return { method: "windows-symlink-fallback", atomic: false };
  }
}

/**
 * 将 current 指针替换到指定 release，目标必须位于 releases 内。
 * @param {object} input 输入。
 * @param {string} input.installRoot 安装根目录。
 * @param {string} input.targetReleaseDir 目标 release。
 * @returns {Promise<object>} 指针替换摘要。
 */
async function pointCurrentToRelease({ installRoot, targetReleaseDir }) {
  const installRootRealPath = await realpath(path.resolve(installRoot));
  const releasesDir = await resolveExistingDirectoryRealPath(
    path.join(installRootRealPath, "releases"),
    installRootRealPath,
    "releases",
  );
  const releaseDir = await resolveExistingDirectoryRealPath(
    targetReleaseDir,
    releasesDir,
    "releases/<version>",
  );
  const currentPath = path.join(installRootRealPath, "current");
  const currentNextPath = `${currentPath}.next`;
  assertInsideInstallRoot(currentNextPath, installRootRealPath);
  await rm(currentNextPath, { recursive: true, force: true });
  const linkTarget =
    process.platform === "win32"
      ? releaseDir
      : path.relative(path.dirname(currentPath), releaseDir);
  await symlink(
    linkTarget,
    currentNextPath,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assertCurrentPathInsideReleases(currentNextPath, releasesDir);
  const renameResult = await renameCurrentPointer(currentNextPath, currentPath);
  const current = await assertCurrentPathInsideReleases(currentPath, releasesDir);
  const currentRealPath = await realpath(currentPath);
  assert(currentRealPath === releaseDir, "current symlink target mismatch");
  return {
    current,
    current_path: currentPath,
    current_target: releaseDir,
    switched_at: new Date().toISOString(),
    temp_path: currentNextPath,
    rename: renameResult,
  };
}

/**
 * 原子切换 current symlink 到候选 release。
 * @param {object} input 输入。
 * @param {string} input.installRoot 安装根目录。
 * @param {Record<string, unknown>} input.manifest manifest。
 * @param {object} input.previousCurrent 切换前 current 摘要。
 * @returns {Promise<object>} 切换摘要。
 */
export async function switchCurrentSymlink({ installRoot, manifest, previousCurrent }) {
  const paths = await resolveCandidateMigrationPaths({ installRoot, manifest });
  const switched = await pointCurrentToRelease({
    installRoot: paths.installRoot,
    targetReleaseDir: paths.releaseDir,
  });
  return {
    ...switched,
    previous_current: previousCurrent,
  };
}

/**
 * 默认 systemctl runner；不经 shell，只允许调用方传入白名单 unit。
 * @param {string} command 命令。
 * @param {string[]} args 参数。
 * @returns {{ status: number | null, signal: string | null, stdout: string, stderr: string, error?: Error }} 结果。
 */
function defaultSystemctlRunner(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

/**
 * 只重启 manifest 中的 GPT2Image-Pro 白名单 systemd 单元。
 * @param {object} input 输入。
 * @param {Record<string, unknown>} input.manifest manifest。
 * @param {Function | undefined} input.runner 可注入 systemctl runner。
 * @param {string | undefined} input.logPath updater 日志路径。
 * @returns {Promise<object>} 重启摘要。
 */
export async function restartWhitelistedServices({
  manifest,
  runner = defaultSystemctlRunner,
  logPath = defaultUpdaterLogPath,
}) {
  const units = assertAllowedSystemdUnits(manifest);
  const restartedUnits = [];
  for (const { name, unit } of units) {
    assert(ALLOWED_SYSTEMD_UNITS.includes(unit), `systemd unit is not allowed: ${unit}`);
    const args = ["restart", unit];
    const rawResult = await runner("systemctl", args);
    const result = sanitizeMigrationResult(rawResult);
    const record = {
      service: name,
      unit,
      command: "systemctl",
      args,
      result,
      restarted_at: new Date().toISOString(),
    };
    restartedUnits.push(record);
    await appendUpdaterLog(logPath, {
      at: record.restarted_at,
      event: "systemd_restart_finished",
      service: name,
      unit,
      command: "systemctl",
      args,
      result,
    });
    assert(
      result.exitCode === 0 && !result.error,
      `systemctl restart failed for whitelisted unit: ${unit}`,
    );
  }
  return {
    allowedSystemdUnits: ALLOWED_SYSTEMD_UNITS,
    restarted_units: restartedUnits,
    forbiddenUnits: ["postgresql.service", "nginx.service", "docker.service"],
  };
}

/**
 * 合并写入 apply journal，用于 current 切换、restart、healthcheck 和 rollback。
 * @param {string} applyJsonPath apply.json 路径。
 * @param {Record<string, unknown>} patch 追加字段。
 * @returns {Promise<object>} 合并后的 journal。
 */
export async function writeApplyJournal(applyJsonPath, patch) {
  const current = (await pathExists(applyJsonPath)) ? await readJson(applyJsonPath) : {};
  const next = { ...current, ...patch };
  await writeApplyProgress(applyJsonPath, next);
  return next;
}

/**
 * 等待指定毫秒。
 * @param {number} milliseconds 毫秒。
 * @returns {Promise<void>} 无返回。
 */
function sleep(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/**
 * 读取 healthcheck 数值字段。
 * @param {Record<string, unknown>} value 配置。
 * @param {string} field 字段名。
 * @param {number} fallback 默认值。
 * @returns {number} 数值。
 */
function readHealthcheckNumber(value, field, fallback) {
  const raw = value[field];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}

/**
 * 从 manifest 构造 Web 与 proxy 健康检查探针。
 * @param {Record<string, unknown>} manifest manifest。
 * @returns {object[]} 探针列表。
 */
function buildHealthcheckProbes(manifest) {
  const healthcheck = assertObject(manifest.healthcheck, "manifest.healthcheck");
  const web = assertObject(healthcheck.web, "manifest.healthcheck.web");
  const proxy = assertObject(
    healthcheck["chatgpt-web-proxy"],
    "manifest.healthcheck.chatgpt-web-proxy",
  );
  const webHost = typeof web.host === "string" ? web.host : "127.0.0.1";
  const webPort = readHealthcheckNumber(web, "port", 3000);
  const webPath = typeof web.path === "string" ? web.path : "/api/health";
  const proxyHost = typeof proxy.host === "string" ? proxy.host : "127.0.0.1";
  const proxyPort = readHealthcheckNumber(proxy, "port", 3021);
  return [
    {
      name: "web",
      type: "http",
      host: webHost,
      port: webPort,
      path: webPath,
      endpoint: `${webHost}:${webPort}${webPath}`,
      defaultEndpoint: "127.0.0.1:3000/api/health",
      expectedStatus: readHealthcheckNumber(web, "expected_status", 200),
      timeoutMs: readHealthcheckNumber(web, "timeout_seconds", 5) * 1000,
      retries: readHealthcheckNumber(web, "retries", 6),
    },
    {
      name: "chatgpt-web-proxy",
      type: "tcp",
      host: proxyHost,
      port: proxyPort,
      endpoint: `${proxyHost}:${proxyPort}`,
      defaultEndpoint: "127.0.0.1:3021",
      timeoutMs: readHealthcheckNumber(proxy, "timeout_seconds", 5) * 1000,
      retries: readHealthcheckNumber(proxy, "retries", 6),
    },
  ];
}

/**
 * 执行一次 HTTP 健康检查。
 * @param {object} probe 探针。
 * @returns {Promise<object>} 结果。
 */
async function probeHttpOnce(probe) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), probe.timeoutMs);
  try {
    const response = await fetch(`http://${probe.endpoint}`, {
      method: "GET",
      signal: controller.signal,
    });
    return {
      ok: response.status === probe.expectedStatus,
      status: response.status,
      expectedStatus: probe.expectedStatus,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 执行一次 TCP 健康检查。
 * @param {object} probe 探针。
 * @returns {Promise<object>} 结果。
 */
async function probeTcpOnce(probe) {
  return await new Promise((resolve) => {
    const socket = net.createConnection({ host: probe.host, port: probe.port });
    const finish = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(probe.timeoutMs);
    socket.once("connect", () => finish({ ok: true }));
    socket.once("timeout", () => finish({ ok: false, error: "timeout" }));
    socket.once("error", (error) =>
      finish({ ok: false, error: redactSensitiveText(error.message) }),
    );
  });
}

/**
 * 默认健康检查 runner，支持 Web HTTP 与 ChatGPT Web proxy TCP。
 * @param {object} probe 探针。
 * @returns {Promise<object>} 结果。
 */
async function defaultHealthcheckRunner(probe) {
  if (probe.type === "http") {
    return await probeHttpOnce(probe);
  }
  if (probe.type === "tcp") {
    return await probeTcpOnce(probe);
  }
  throw new Error(`unsupported healthcheck type: ${probe.type}`);
}

/**
 * 执行 healthcheck probes；返回每个探针的最终状态，不直接修改 current。
 * @param {object} input 输入。
 * @param {Record<string, unknown>} input.manifest manifest。
 * @param {Function | undefined} input.runner 可注入 probe runner。
 * @param {string | undefined} input.logPath updater 日志路径。
 * @returns {Promise<object>} healthcheck 摘要。
 */
export async function runHealthchecks({
  manifest,
  runner = defaultHealthcheckRunner,
  logPath = defaultUpdaterLogPath,
}) {
  const startedAt = new Date().toISOString();
  const probes = buildHealthcheckProbes(manifest);
  const results = [];
  for (const probe of probes) {
    const attempts = [];
    for (let attempt = 1; attempt <= probe.retries; attempt += 1) {
      try {
        const result = await runner(probe, attempt);
        attempts.push({
          attempt,
          ok: result.ok === true,
          result: {
            ...result,
            error: result.error ? redactSensitiveText(result.error) : null,
          },
        });
        if (result.ok === true) {
          break;
        }
      } catch (error) {
        attempts.push({
          attempt,
          ok: false,
          result: {
            error: redactSensitiveText(
              error instanceof Error ? error.message : String(error),
            ),
          },
        });
      }
      if (attempt < probe.retries) {
        await sleep(1000);
      }
    }
    const ok = attempts.some((attempt) => attempt.ok);
    results.push({
      name: probe.name,
      type: probe.type,
      endpoint: probe.endpoint,
      defaultEndpoint: probe.defaultEndpoint,
      ok,
      attempts,
    });
    await appendUpdaterLog(logPath, {
      at: new Date().toISOString(),
      event: "healthcheck_probe_finished",
      name: probe.name,
      endpoint: probe.endpoint,
      ok,
    });
  }
  const finishedAt = new Date().toISOString();
  const ok = results.every((result) => result.ok);
  return {
    healthcheck_started_at: startedAt,
    healthcheck_finished_at: finishedAt,
    healthcheck_status: ok ? "completed" : "failed",
    ok,
    results,
  };
}

/**
 * 回滚应用层 current 指针和白名单服务；数据库迁移不可自动回滚。
 * @param {object} input 输入。
 * @param {string} input.installRoot 安装根目录。
 * @param {object} input.previousCurrent 切换前 current 摘要。
 * @param {Record<string, unknown>} input.manifest manifest。
 * @param {Function | undefined} input.systemctlRunner 可注入 systemctl runner。
 * @param {string | undefined} input.logPath updater 日志路径。
 * @returns {Promise<object>} rollback 摘要。
 */
export async function rollbackApplicationLayer({
  installRoot,
  previousCurrent,
  manifest,
  systemctlRunner,
  logPath = defaultUpdaterLogPath,
}) {
  const startedAt = new Date().toISOString();
  assert(
    previousCurrent?.exists === true && typeof previousCurrent.releaseDir === "string",
    "previous_current is required for application rollback",
  );
  const restoredCurrent = await pointCurrentToRelease({
    installRoot,
    targetReleaseDir: previousCurrent.releaseDir,
  });
  const restart = await restartWhitelistedServices({
    manifest,
    runner: systemctlRunner,
    logPath,
  });
  const finishedAt = new Date().toISOString();
  const rollback = {
    rollback_status: "completed",
    rollback_started_at: startedAt,
    rollback_finished_at: finishedAt,
    previous_current: previousCurrent,
    restored_current: restoredCurrent,
    restarted_units: restart.restarted_units,
    db_migration_irreversible: true,
    rollback_scope:
      "restore current and restart gpt2image-web.service/gpt2image-chatgpt-web-proxy.service only; DB migration must be handled manually if needed",
  };
  await appendUpdaterLog(logPath, {
    at: finishedAt,
    event: "rollback_finished",
    rollback_status: "completed",
    previous_current: previousCurrent.releaseDir,
    db_migration_irreversible: true,
  });
  return rollback;
}

/**
 * 执行 apply/update 命令骨架，按 preflight -> installStagedRelease -> runCandidateMigration -> current switch -> restart -> healthcheck 顺序推进。
 * @param {Map<string, string | boolean>} args 参数映射。
 * @param {"apply" | "update"} command 命令名。
 * @param {object} options 注入项。
 * @returns {Promise<object>} apply/update 预检摘要。
 */
async function runApply(args, command = "apply", options = {}) {
  const { installRoot, manifestSource, envFile } = requireApplyRuntimeArgs(args);
  await verifySchemaBaseline();
  const expectedPlatform = readStringArg(args, "platform") ?? supportedPlatform;
  const { source, manifest } = await readManifestSource(manifestSource);
  verifyManifest(manifest, expectedPlatform);
  const preflight = await preflightApplyRuntime({ installRoot, manifest, envFile });
  const artifactPath = readStringArg(args, "artifact-file");
  const runId = readStringArg(args, "run-id");
  if (artifactPath) {
    const lock = await acquireUpdateLock(installRoot);
    try {
      const stageResult = await stageArtifact({
        installRoot,
        artifactPath: path.resolve(artifactPath),
        manifest,
        runId,
        envFile,
      });
      const install = await installStagedRelease({
        installRoot,
        manifest,
        runId,
        stageResult,
        expectedPlatform,
      });
      const previousCurrent = await capturePreviousCurrent({ installRoot });
      assert(
        previousCurrent.exists === true,
        "previous_current is required before DB migration and rollback",
      );
      const migration = await runCandidateMigration({
        installRoot,
        manifest,
        runId,
        envFile,
        previousCurrent,
        runner: options.migrationRunner,
        logPath: options.logPath,
      });
      const currentSwitch = await switchCurrentSymlink({
        installRoot,
        manifest,
        previousCurrent,
      });
      const restart = await restartWhitelistedServices({
        manifest,
        runner: options.systemctlRunner,
        logPath: options.logPath,
      });
      await writeApplyJournal(migration.apply_json, {
        previous_current: previousCurrent,
        current_target: currentSwitch.current_target,
        switched_at: currentSwitch.switched_at,
        restarted_units: restart.restarted_units,
        healthcheck_status: "running",
        rollback_status: "not_required",
      });
      const healthcheck = await runHealthchecks({
        manifest,
        runner: options.healthcheckRunner,
        logPath: options.logPath,
      });
      if (!healthcheck.ok) {
        const rollback = await rollbackApplicationLayer({
          installRoot,
          previousCurrent,
          manifest,
          systemctlRunner: options.systemctlRunner,
          logPath: options.logPath,
        });
        const rollbackHealthcheck = await runHealthchecks({
          manifest,
          runner: options.healthcheckRunner,
          logPath: options.logPath,
        });
        await writeApplyJournal(migration.apply_json, {
          healthcheck_results: healthcheck,
          rollback_status: rollback.rollback_status,
          rollback,
          rollback_healthcheck_results: rollbackHealthcheck,
          db_migration_irreversible: true,
        });
        throw new Error(
          `healthcheck failed after current switch; application rollback ${rollback.rollback_status}`,
        );
      }
      await writeApplyJournal(migration.apply_json, {
        healthcheck_results: healthcheck,
        healthcheck_status: healthcheck.healthcheck_status,
        rollback_status: "not_required",
        db_migration_irreversible: true,
      });
      return {
        command,
        dryRun: false,
        phase: "M1-P4 install migrate switch restart healthcheck",
        applied: true,
        installed: true,
        migrated: true,
        switched: true,
        restarted: true,
        healthchecked: true,
        installRoot,
        manifest: source,
        envFile,
        preflight,
        install,
        migration,
        currentSwitch,
        restart,
        healthcheck,
        blockedOperations: [
          "touch PostgreSQL/Nginx/Docker/Admin/UOL/UI",
        ],
      };
    } finally {
      await releaseUpdateLock(lock);
    }
  }
  return {
    command,
    dryRun: false,
    phase: "M1-P4 preflight skeleton",
    applied: false,
    installRoot,
    manifest: source,
    envFile,
    preflight,
    blockedOperations: [
      "provide --artifact-file to install releases/<version>",
      "switch current",
      "run migrations",
      "call systemctl",
      "restart gpt2image-web.service",
      "restart gpt2image-chatgpt-web-proxy.service",
      "touch PostgreSQL/Nginx/Docker/Admin/UOL/UI",
    ],
  };
}

/**
 * 输出 JSON。
 * @param {(message: string) => void} write 输出函数。
 * @param {unknown} value 输出值。
 * @returns {void} 无返回。
 */
function writeJson(write, value) {
  write(`${redactSensitiveText(JSON.stringify(value, null, 2))}\n`);
}

/**
 * 防止 mutating 命令静默忽略 dry-run 标记。
 * @param {string} command 命令名。
 * @param {Map<string, string | boolean>} args 参数映射。
 * @returns {void} 无返回。
 */
function assertDryRunFlagAllowed(command, args) {
  if (
    (command === "apply" ||
      command === "download" ||
      command === "stage" ||
      command === "update") &&
    args.has("dry-run")
  ) {
    throw new Error(
      `${command} does not support --dry-run; use check, plan, status, or dry-run instead`,
    );
  }
}

/**
 * 执行命令分发。
 * @param {string[]} argv 参数。
 * @param {(message: string) => void} write 标准输出函数。
 * @returns {Promise<void>} 无返回。
 */
export async function dispatch(argv, write = (message) => process.stdout.write(message)) {
  const { command, args } = parseArgs(argv);
  const rawSelfTest = args.get("self-test");
  const selfTest = rawSelfTest === true ? "all" : readStringArg(args, "self-test");
  if (selfTest) {
    assert(
      selfTest === "all" ||
        selfTest === "cli" ||
        selfTest === "check" ||
        selfTest === "download" ||
        selfTest === "stage" ||
        selfTest === "apply",
      "--self-test only supports all, cli, check, download, stage, or apply",
    );
    if (selfTest === "cli") {
      await runCliSelfTest();
      write("Local updater CLI self-test passed.\n");
      return;
    }
    if (selfTest === "check") {
      await runCheckSelfTest();
      write("Local updater check self-test passed.\n");
      return;
    }
    if (selfTest === "download") {
      await runDownloadSelfTest();
      write("Local updater download self-test passed.\n");
      return;
    }
    if (selfTest === "stage") {
      await runStageSelfTest();
      write("Local updater stage self-test passed.\n");
      return;
    }
    if (selfTest === "apply") {
      await runApplySelfTest();
      write("Local updater apply self-test passed.\n");
      return;
    }
    await runCliSelfTest();
    await runCheckSelfTest();
    await runDownloadSelfTest();
    await runStageSelfTest();
    await runApplySelfTest();
    write("Local updater self-test passed.\n");
    return;
  }

  if (args.get("help") === true || !command) {
    write(`${formatHelp()}\n`);
    return;
  }

  assert(commandNames.has(command), `Unknown command: ${command}`);
  assertDryRunFlagAllowed(command, args);
  if (command === "apply" || command === "update") {
    writeJson(write, await runApply(args, command));
    return;
  }
  if (command === "check") {
    writeJson(write, await runCheck(args));
    return;
  }
  if (command === "download") {
    writeJson(write, await runDownload(args));
    return;
  }
  if (command === "stage") {
    writeJson(write, await runStage(args));
    return;
  }
  if (command === "status") {
    writeJson(write, await readInstallStatus(resolveInstallRoot(args)));
    return;
  }
  if (command === "plan") {
    writeJson(write, await runPlan(args, "plan"));
    return;
  }
  writeJson(write, await runPlan(args, "dry-run"));
}

/**
 * 捕获 CLI 执行结果，供 self-test 断言。
 * @param {string[]} argv 参数。
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>} 执行结果。
 */
async function invokeForTest(argv) {
  let stdout = "";
  let stderr = "";
  try {
    await dispatch(argv, (message) => {
      stdout += message;
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    stderr += error instanceof Error ? error.message : String(error);
    return { exitCode: 1, stdout, stderr };
  }
}

/**
 * 创建自测用 manifest。
 * @param {string} filePath manifest 路径。
 * @returns {Promise<void>} 无返回。
 */
async function writeSelfTestManifest(filePath, overrides = {}) {
  const manifest = {
    version: "v0.0.0-alpha.0",
    commit: "0000000000000000000000000000000000000000",
    platform: supportedPlatform,
    artifact_url:
      "https://downloads.example.invalid/gpt2image-pro/v0.0.0-alpha.0/gpt2image-pro-v0.0.0-alpha.0-linux-x64.tar.gz",
    artifact_sha256:
      "0000000000000000000000000000000000000000000000000000000000000000",
    minimum_supported_version: "v0.0.0-alpha.0",
    migration_mode: "pre_switch",
    services: {
      web: {
        systemd_unit: "gpt2image-web.service",
        runtime: "next-standalone",
        port: 3000,
        restart_order: 1,
        healthcheck: "web",
        resident: true,
      },
      "chatgpt-web-proxy": {
        systemd_unit: "gpt2image-chatgpt-web-proxy.service",
        runtime: "go-sidecar",
        port: 3021,
        restart_order: 2,
        healthcheck: "chatgpt-web-proxy",
        resident: true,
      },
    },
    healthcheck: {
      web: {
        type: "http",
        host: "127.0.0.1",
        port: 3000,
        path: "/api/health",
        expected_status: 200,
        timeout_seconds: 5,
        retries: 6,
      },
      "chatgpt-web-proxy": {
        type: "tcp",
        host: "127.0.0.1",
        port: 3021,
        timeout_seconds: 5,
        retries: 6,
      },
    },
    ...overrides,
  };
  await writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * 断言 CLI 结果。
 * @param {boolean} condition 条件。
 * @param {string} message 错误消息。
 * @returns {void} 无返回。
 */
function assertSelfTest(condition, message) {
  if (!condition) {
    throw new Error(`self-test failed: ${message}`);
  }
}

/**
 * 运行 CLI 自测。
 * @returns {Promise<void>} 无返回。
 */
export async function runCliSelfTest() {
  const help = await invokeForTest(["--help"]);
  assertSelfTest(help.exitCode === 0, "help should exit 0");
  assertSelfTest(help.stdout.includes("check"), "help should mention check");

  const unknown = await invokeForTest(["unknown"]);
  assertSelfTest(unknown.exitCode === 1, "unknown command should fail");
  assertSelfTest(
    unknown.stderr.includes("Unknown command"),
    "unknown command should explain failure",
  );

  const mutatingDryRun = await invokeForTest(["download", "--dry-run"]);
  assertSelfTest(mutatingDryRun.exitCode === 1, "mutating dry-run should fail");
  assertSelfTest(
    mutatingDryRun.stderr.includes("does not support --dry-run"),
    "mutating dry-run should explain safe alternatives",
  );

  const missing = await invokeForTest(["check"]);
  assertSelfTest(missing.exitCode === 1, "missing manifest should fail");
  assertSelfTest(
    missing.stderr.includes("--manifest"),
    "missing manifest should explain required argument",
  );

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "gpt2image-updater-cli-"));
  try {
    const installRoot = path.join(tempRoot, "install");
    const manifestPath = path.join(tempRoot, "manifest.json");
    await mkdir(installRoot, { recursive: true });
    await writeSelfTestManifest(manifestPath);
    const before = await readdir(installRoot);
    const dryRun = await invokeForTest([
      "dry-run",
      "--install-root",
      installRoot,
      "--manifest",
      manifestPath,
    ]);
    const after = await readdir(installRoot);
    assertSelfTest(dryRun.exitCode === 0, "dry-run should pass");
    assertSelfTest(before.length === 0, "install root should start empty");
    assertSelfTest(after.length === 0, "dry-run should not write install root");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

/**
 * 写入指定版本的 manifest fixture。
 * @param {string} tempRoot 临时目录。
 * @param {string} name 文件名。
 * @param {Record<string, unknown>} overrides 覆盖字段。
 * @returns {Promise<string>} manifest 路径。
 */
async function writeNamedSelfTestManifest(tempRoot, name, overrides) {
  const manifestPath = path.join(tempRoot, `${name}.json`);
  await writeSelfTestManifest(manifestPath, overrides);
  return manifestPath;
}

/**
 * 执行 check 命令并解析 JSON 输出。
 * @param {string} manifestPath manifest 路径。
 * @param {string} currentVersion 当前版本。
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string, json?: object }>} 执行结果。
 */
async function invokeCheckForTest(manifestPath, currentVersion) {
  const result = await invokeForTest([
    "check",
    "--manifest",
    manifestPath,
    "--current-version",
    currentVersion,
    "--platform",
    supportedPlatform,
    "--dry-run",
  ]);
  if (result.exitCode === 0) {
    result.json = JSON.parse(result.stdout);
  }
  return result;
}

/**
 * 运行 manifest check 与版本决策自测。
 * @returns {Promise<void>} 无返回。
 */
export async function runCheckSelfTest() {
  assertSelfTest(
    compareProjectVersions("v1.0.0", "v1.0.0-rc.1") > 0,
    "stable release should sort after prerelease",
  );
  assertSelfTest(
    compareProjectVersions("v1.0.0-beta.2", "v1.0.0-beta.1") > 0,
    "prerelease number should sort ascending",
  );

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "gpt2image-updater-check-"));
  try {
    const upgradeManifest = await writeNamedSelfTestManifest(tempRoot, "upgrade", {
      version: "v0.0.1-alpha.0",
      minimum_supported_version: "v0.0.0-alpha.0",
    });
    const upgrade = await invokeCheckForTest(upgradeManifest, "v0.0.0-alpha.0");
    assertSelfTest(upgrade.exitCode === 0, "upgrade check should pass");
    assertSelfTest(upgrade.json.decision === "upgrade", "upgrade decision expected");

    const sameManifest = await writeNamedSelfTestManifest(tempRoot, "same", {
      version: "v0.0.1-alpha.0",
      minimum_supported_version: "v0.0.0-alpha.0",
    });
    const same = await invokeCheckForTest(sameManifest, "v0.0.1-alpha.0");
    assertSelfTest(same.exitCode === 0, "same-version check should pass");
    assertSelfTest(same.json.decision === "no-update", "no-update decision expected");

    const downgradeManifest = await writeNamedSelfTestManifest(tempRoot, "downgrade", {
      version: "v0.0.1-alpha.0",
      minimum_supported_version: "v0.0.0-alpha.0",
    });
    const downgrade = await invokeCheckForTest(downgradeManifest, "v0.0.2-alpha.0");
    assertSelfTest(downgrade.exitCode === 0, "downgrade check should pass");
    assertSelfTest(downgrade.json.decision === "downgrade", "downgrade decision expected");

    const minimumManifest = await writeNamedSelfTestManifest(tempRoot, "minimum", {
      version: "v0.0.3-alpha.0",
      minimum_supported_version: "v0.0.2-alpha.0",
    });
    const minimum = await invokeCheckForTest(minimumManifest, "v0.0.1-alpha.0");
    assertSelfTest(minimum.exitCode === 0, "minimum check should pass");
    assertSelfTest(
      minimum.json.decision === "minimum-unsupported",
      "minimum unsupported decision expected",
    );

    const platformManifest = await writeNamedSelfTestManifest(tempRoot, "platform", {
      platform: "linux-arm64",
    });
    const platform = await invokeCheckForTest(platformManifest, "v0.0.0-alpha.0");
    assertSelfTest(platform.exitCode === 1, "platform mismatch should fail");
    assertSelfTest(
      platform.stderr.includes("platform"),
      "platform mismatch should mention platform",
    );

    const checksumManifest = await writeNamedSelfTestManifest(tempRoot, "checksum", {
      artifact_sha256: "not-a-sha256",
    });
    const checksum = await invokeCheckForTest(checksumManifest, "v0.0.0-alpha.0");
    assertSelfTest(checksum.exitCode === 1, "checksum format should fail");
    assertSelfTest(
      checksum.stderr.includes("artifact_sha256"),
      "checksum failure should mention artifact_sha256",
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

/**
 * 运行 download 自测。
 * @returns {Promise<void>} 无返回。
 */
export async function runDownloadSelfTest() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "gpt2image-updater-download-"));
  try {
    const installRoot = path.join(tempRoot, "install");
    const sourceArtifact = path.join(tempRoot, "source.tar.gz");
    await mkdir(installRoot, { recursive: true });
    await writeFile(sourceArtifact, "artifact fixture");
    const artifactSha256 = await sha256File(sourceArtifact);
    const manifestPath = await writeNamedSelfTestManifest(tempRoot, "download", {
      version: "v0.0.1-alpha.0",
      artifact_url:
        "https://downloads.example.invalid/gpt2image-pro/v0.0.1-alpha.0/gpt2image-pro-v0.0.1-alpha.0-linux-x64.tar.gz",
      artifact_sha256: artifactSha256,
      minimum_supported_version: "v0.0.0-alpha.0",
    });
    const manifest = await readJson(manifestPath);
    const checksumFile = path.join(tempRoot, "artifact.sha256");
    await writeFile(
      checksumFile,
      `${artifactSha256}  gpt2image-pro-v0.0.1-alpha.0-linux-x64.tar.gz
`,
    );

    const downloaded = await downloadArtifact({
      installRoot,
      manifest,
      artifactFile: sourceArtifact,
      checksumFile,
      runId: "success",
    });
    assertSelfTest(await pathExists(downloaded.artifactPath), "artifact should exist");
    assertSelfTest(
      !(await pathExists(`${downloaded.artifactPath}.partial`)),
      ".partial should be renamed away",
    );

    const badChecksumManifest = { ...manifest, artifact_sha256: "1".repeat(64) };
    const mismatch = await invokeDownloadFailure({
      installRoot,
      manifest: badChecksumManifest,
      artifactFile: sourceArtifact,
      runId: "mismatch",
    });
    assertSelfTest(mismatch.includes("sha256"), "checksum mismatch should fail");

    const badNameManifest = {
      ...manifest,
      artifact_url: "https://downloads.example.invalid/bad.tar.gz",
    };
    const badName = await invokeDownloadFailure({
      installRoot,
      manifest: badNameManifest,
      artifactFile: sourceArtifact,
      runId: "bad-name",
    });
    assertSelfTest(badName.includes("version"), "filename mismatch should fail");

    const partialTarget = path.join(tempRoot, "partial", "artifact.tar.gz");
    await mkdir(path.dirname(partialTarget), { recursive: true });
    await writeFile(`${partialTarget}.partial`, "old partial");
    try {
      await downloadToPartial(path.join(tempRoot, "missing.tar.gz"), partialTarget);
      throw new Error("missing source should fail");
    } catch {
      assertSelfTest(
        !(await pathExists(`${partialTarget}.partial`)),
        "failed download should clean .partial",
      );
    }

    await writeFile(`${partialTarget}.partial`, "old partial");
    await downloadToPartial(sourceArtifact, partialTarget);
    assertSelfTest(await pathExists(partialTarget), "repeat download should write final file");
    assertSelfTest(
      !(await pathExists(`${partialTarget}.partial`)),
      "repeat download should remove old .partial",
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

/**
 * 捕获 downloadArtifact 失败消息。
 * @param {object} input 输入。
 * @returns {Promise<string>} 错误消息。
 */
async function invokeDownloadFailure(input) {
  try {
    await downloadArtifact(input);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("download was expected to fail");
}

/**
 * 写入最小可验证 bundle 目录。
 * @param {string} bundleDir bundle 目录。
 * @param {Record<string, unknown>} manifestOverrides manifest 覆盖项。
 * @returns {Promise<void>} 无返回。
 */
async function writeMinimalBundleFixture(bundleDir, manifestOverrides = {}) {
  const directoryPaths = new Set([
    "apps/web/.next/static",
    "apps/web/public",
    "migrator/packages/database/src",
  ]);
  for (const relativePath of requiredBundlePaths) {
    const target = path.join(bundleDir, relativePath);
    if (directoryPaths.has(relativePath)) {
      await mkdir(target, { recursive: true });
    } else if (relativePath !== "SHA256SUMS") {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, `${relativePath}
`);
    }
  }
  await writeSelfTestManifest(path.join(bundleDir, "manifest.json"), manifestOverrides);
  const manifestSha256 = await sha256File(path.join(bundleDir, "manifest.json"));
  await writeFile(path.join(bundleDir, "SHA256SUMS"), `${manifestSha256}  manifest.json
`);
}

/**
 * 创建 tar.gz fixture。
 * @param {string} tempRoot 临时目录。
 * @param {string} bundleName bundle 目录名。
 * @param {Record<string, unknown>} manifestOverrides manifest 覆盖项。
 * @returns {Promise<string>} artifact 路径。
 */
async function createTarFixture(tempRoot, bundleName, manifestOverrides = {}) {
  const bundleDir = path.join(tempRoot, bundleName);
  await writeMinimalBundleFixture(bundleDir, manifestOverrides);
  const artifactPath = path.join(tempRoot, `${bundleName}.tar.gz`);
  const result = spawnSync("tar", ["-czf", artifactPath, "-C", tempRoot, bundleName], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`tar create failed: ${result.stderr || result.stdout}`.trim());
  }
  return artifactPath;
}

/**
 * 运行 stage 自测。
 * @returns {Promise<void>} 无返回。
 */
export async function runStageSelfTest() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "gpt2image-updater-stage-"));
  try {
    const installRoot = path.join(tempRoot, "install");
    const envFile = path.join(tempRoot, "gpt2image.env");
    await mkdir(path.join(installRoot, "shared", "staging"), { recursive: true });
    await writeFile(path.join(installRoot, "shared", "sentinel.txt"), "keep");
    await writeFile(
      envFile,
      "DATABASE_URL=postgresql://placeholder\nBETTER_AUTH_SECRET=placeholder\n",
    );

    const firstLock = await acquireUpdateLock(installRoot);
    try {
      try {
        await acquireUpdateLock(installRoot);
        throw new Error("second lock should fail");
      } catch (error) {
        assertSelfTest(
          String(error).includes("updater lock"),
          "second lock should report updater lock",
        );
      }
    } finally {
      await releaseUpdateLock(firstLock);
    }

    try {
      assertSafeArchiveEntry("../evil");
      throw new Error("path traversal should fail");
    } catch (error) {
      assertSelfTest(
        String(error).includes("path traversal"),
        "path traversal should be rejected",
      );
    }

    const bundleName = "gpt2image-pro-v0.0.1-alpha.0-linux-x64";
    const artifactPath = await createTarFixture(tempRoot, bundleName);
    const artifactSha256 = await sha256File(artifactPath);
    const manifestPath = await writeNamedSelfTestManifest(tempRoot, "stage", {
      version: "v0.0.1-alpha.0",
      artifact_url:
        "https://downloads.example.invalid/gpt2image-pro/v0.0.1-alpha.0/gpt2image-pro-v0.0.1-alpha.0-linux-x64.tar.gz",
      artifact_sha256: artifactSha256,
      minimum_supported_version: "v0.0.0-alpha.0",
    });
    const manifest = await readJson(manifestPath);
    const staged = await stageArtifact({
      installRoot,
      artifactPath,
      manifest,
      runId: "stage-ok",
      envFile,
    });
    assertSelfTest(await pathExists(staged.bundleDir), "bundle dir should exist");
    assertSelfTest(
      await pathExists(path.join(installRoot, "shared", "sentinel.txt")),
      "cleanup should not remove shared sentinel",
    );

    const missingEnv = await invokeStageFailure({
      installRoot,
      artifactPath,
      manifest,
      runId: "missing-env",
      envFile: path.join(tempRoot, "missing.env"),
    });
    assertSelfTest(missingEnv.includes("env-file"), "missing env should fail");

    const missingNameEnv = path.join(tempRoot, "missing-name.env");
    await writeFile(missingNameEnv, "DATABASE_URL=postgresql://placeholder\n");
    const missingName = await invokeStageFailure({
      installRoot,
      artifactPath,
      manifest,
      runId: "missing-name",
      envFile: missingNameEnv,
    });
    assertSelfTest(
      missingName.includes("BETTER_AUTH_SECRET"),
      "missing env name should fail",
    );

    const badBundleDir = path.join(tempRoot, "bad-bundle");
    await mkdir(badBundleDir, { recursive: true });
    await writeFile(path.join(badBundleDir, "manifest.json"), "{}\n");
    const badArtifact = path.join(tempRoot, "bad.tar.gz");
    const badTar = spawnSync("tar", ["-czf", badArtifact, "-C", tempRoot, "bad-bundle"], {
      encoding: "utf8",
    });
    if (badTar.status !== 0) {
      throw new Error(`tar create failed: ${badTar.stderr || badTar.stdout}`.trim());
    }
    const badManifest = {
      ...manifest,
      artifact_sha256: await sha256File(badArtifact),
    };
    const missingRequired = await invokeStageFailure({
      installRoot,
      artifactPath: badArtifact,
      manifest: badManifest,
      runId: "missing-required",
      envFile,
    });
    assertSelfTest(
      missingRequired.includes("bundle missing required path"),
      "missing required bundle path should fail",
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

/**
 * 捕获 stageArtifact 失败消息。
 * @param {object} input 输入。
 * @returns {Promise<string>} 错误消息。
 */
async function invokeStageFailure(input) {
  try {
    await stageArtifact(input);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("stage was expected to fail");
}

/**
 * 构建 apply 自测 fixture。覆盖 migration failure、healthcheck rollback、service whitelist、secret redaction 和 stale lock。
 * @param {string} tempRoot 临时根目录。
 * @param {string} name fixture 名称。
 * @param {Record<string, unknown>} manifestOverrides detached manifest 覆盖项。
 * @returns {Promise<object>} fixture。
 */
async function createApplySelfTestFixture(tempRoot, name, manifestOverrides = {}) {
  const fixtureRoot = path.join(tempRoot, name);
  const installRoot = path.join(fixtureRoot, "install");
  const previousVersion = "v0.0.0-alpha.0";
  const nextVersion =
    typeof manifestOverrides.version === "string"
      ? manifestOverrides.version
      : "v0.0.1-alpha.0";
  const previousRelease = path.join(installRoot, "releases", previousVersion);
  await mkdir(previousRelease, { recursive: true });
  await mkdir(path.join(installRoot, "shared", "staging"), { recursive: true });
  await writeSelfTestManifest(path.join(previousRelease, "manifest.json"), {
    version: previousVersion,
  });
  await symlink(
    previousRelease,
    path.join(installRoot, "current"),
    process.platform === "win32" ? "junction" : "dir",
  );

  const envFile = path.join(fixtureRoot, "gpt2image.env");
  await writeFile(
    envFile,
    [
      "DATABASE_URL=postgresql://user:db-pass@localhost/app",
      "BETTER_AUTH_SECRET=auth-pass",
      "CHATGPT_WEB_PROXY_SECRET=proxy-pass",
      "",
    ].join("\n"),
  );

  const bundleName = `gpt2image-pro-${nextVersion}-linux-x64`;
  const internalManifestOverrides = {
    version: nextVersion,
    minimum_supported_version: previousVersion,
    migration_mode: "pre_switch",
  };
  const artifactPath = await createTarFixture(
    fixtureRoot,
    bundleName,
    internalManifestOverrides,
  );
  const artifactSha256 = await sha256File(artifactPath);
  const manifestPath = await writeNamedSelfTestManifest(fixtureRoot, `${name}-manifest`, {
    ...internalManifestOverrides,
    artifact_url: `https://downloads.example.invalid/gpt2image-pro/${nextVersion}/${bundleName}.tar.gz`,
    artifact_sha256: artifactSha256,
    ...manifestOverrides,
  });
  return {
    fixtureRoot,
    installRoot,
    envFile,
    artifactPath,
    manifestPath,
    logPath: path.join(fixtureRoot, "updater.log"),
    previousRelease,
    nextVersion,
    runId: name,
  };
}

/**
 * 构建 apply 参数 Map。
 * @param {object} fixture fixture。
 * @returns {Map<string, string>} 参数。
 */
function buildApplyArgs(fixture) {
  return new Map([
    ["install-root", fixture.installRoot],
    ["manifest", fixture.manifestPath],
    ["env-file", fixture.envFile],
    ["artifact-file", fixture.artifactPath],
    ["run-id", fixture.runId],
  ]);
}

/**
 * 捕获 apply 失败消息。
 * @param {object} fixture fixture。
 * @param {object} options 注入项。
 * @param {string} label 标签。
 * @returns {Promise<string>} 错误消息。
 */
async function invokeApplyFailure(fixture, options, label = "apply") {
  try {
    await runApply(buildApplyArgs(fixture), "apply", options);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error(`${label} was expected to fail`);
}

/**
 * 断言 current 指向指定 release。
 * @param {string} installRoot 安装根目录。
 * @param {string} expectedRelease 期望 release。
 * @param {string} message 错误消息。
 * @returns {Promise<void>} 无返回。
 */
async function assertCurrentPointsTo(installRoot, expectedRelease, message) {
  const currentRealPath = await realpath(path.join(installRoot, "current"));
  const expectedRealPath = await realpath(expectedRelease);
  assertSelfTest(currentRealPath === expectedRealPath, message);
}

/**
 * 断言文本不含敏感值。
 * @param {string} text 文本。
 * @param {string} label 标签。
 * @returns {void} 无返回。
 */
function assertSecretsRedacted(text, label) {
  for (const secret of ["db-pass", "auth-pass", "proxy-pass", "bearer-token"]) {
    assertSelfTest(!text.includes(secret), `${label} should redact ${secret}`);
  }
}

/**
 * 运行 apply 自测，不调用真实 systemctl、真实数据库或生产 URL。
 * @returns {Promise<void>} 无返回。
 */
export async function runApplySelfTest() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "gpt2image-updater-apply-"));
  try {
    const migrationFailure = await createApplySelfTestFixture(
      tempRoot,
      "migration-failure",
    );
    const migrationSystemctlCalls = [];
    const migrationError = await invokeApplyFailure(migrationFailure, {
      logPath: migrationFailure.logPath,
      migrationRunner: async (command) => {
        if (command === "pnpm") {
          return {
            status: 1,
            signal: null,
            stdout: "DATABASE_URL=postgresql://user:db-pass@localhost/app",
            stderr: "Authorization: Bearer bearer-token",
          };
        }
        return { status: 0, signal: null, stdout: "", stderr: "" };
      },
      systemctlRunner: async (command, args) => {
        migrationSystemctlCalls.push([command, ...args].join(" "));
        return { status: 0, signal: null, stdout: "", stderr: "" };
      },
      healthcheckRunner: async () => ({ ok: true }),
    }, "migration failure");
    assertSelfTest(
      migrationError.includes("DB migration command failed"),
      "migration failure should stop apply",
    );
    await assertCurrentPointsTo(
      migrationFailure.installRoot,
      migrationFailure.previousRelease,
      "migration failure should keep current on previous release",
    );
    assertSelfTest(
      migrationSystemctlCalls.length === 0,
      "migration failure should not restart services",
    );
    assertSelfTest(
      !(await pathExists(resolveLockPath(migrationFailure.installRoot))),
      "migration failure should release shared/updater.lock",
    );
    const failedApplyJson = await readFile(
      path.join(
        migrationFailure.installRoot,
        "shared",
        "staging",
        migrationFailure.runId,
        "apply.json",
      ),
      "utf8",
    );
    assertSelfTest(
      failedApplyJson.includes("\"migration_status\": \"failed\""),
      "migration failure should write failed apply.json",
    );
    assertSelfTest(
      failedApplyJson.includes("\"db_migration_irreversible\": true"),
      "migration failure should keep db_migration_irreversible",
    );
    assertSecretsRedacted(failedApplyJson, "apply.json secret redaction");
    assertSecretsRedacted(
      await readFile(migrationFailure.logPath, "utf8"),
      "updater log secret redaction",
    );

    const missingCurrent = await createApplySelfTestFixture(tempRoot, "missing-current");
    await rm(path.join(missingCurrent.installRoot, "current"), {
      recursive: true,
      force: true,
    });
    let missingCurrentMigrationCalls = 0;
    const missingCurrentError = await invokeApplyFailure(missingCurrent, {
      logPath: missingCurrent.logPath,
      migrationRunner: async () => {
        missingCurrentMigrationCalls += 1;
        return { status: 0, signal: null, stdout: "", stderr: "" };
      },
      systemctlRunner: async () => ({ status: 0, signal: null, stdout: "", stderr: "" }),
      healthcheckRunner: async () => ({ ok: true }),
    }, "missing current");
    assertSelfTest(
      missingCurrentError.includes("previous_current is required before DB migration"),
      "missing current should fail before DB migration",
    );
    assertSelfTest(
      missingCurrentMigrationCalls === 0,
      "missing current should not run DB migration",
    );

    const healthRollback = await createApplySelfTestFixture(
      tempRoot,
      "healthcheck-rollback",
      {
        healthcheck: {
          web: {
            type: "http",
            host: "127.0.0.1",
            port: 3000,
            path: "/api/health",
            expected_status: 200,
            timeout_seconds: 1,
            retries: 1,
          },
          "chatgpt-web-proxy": {
            type: "tcp",
            host: "127.0.0.1",
            port: 3021,
            timeout_seconds: 1,
            retries: 1,
          },
        },
      },
    );
    const healthSystemctlCalls = [];
    let healthcheckRun = 0;
    const rollbackError = await invokeApplyFailure(healthRollback, {
      logPath: healthRollback.logPath,
      migrationRunner: async () => ({ status: 0, signal: null, stdout: "", stderr: "" }),
      systemctlRunner: async (command, args) => {
        healthSystemctlCalls.push([command, ...args].join(" "));
        return { status: 0, signal: null, stdout: "", stderr: "" };
      },
      healthcheckRunner: async (probe) => {
        if (probe.name === "web") {
          healthcheckRun += 1;
        }
        return { ok: healthcheckRun > 1 };
      },
    }, "healthcheck rollback");
    assertSelfTest(
      rollbackError.includes("application rollback completed"),
      "healthcheck rollback should report completed rollback",
    );
    await assertCurrentPointsTo(
      healthRollback.installRoot,
      healthRollback.previousRelease,
      "healthcheck rollback should restore previous_current",
    );
    assertSelfTest(
      healthSystemctlCalls.length === 4,
      "healthcheck rollback should restart two whitelist services twice",
    );
    const rollbackApplyJson = await readFile(
      path.join(
        healthRollback.installRoot,
        "shared",
        "staging",
        healthRollback.runId,
        "apply.json",
      ),
      "utf8",
    );
    assertSelfTest(
      rollbackApplyJson.includes("\"rollback_status\": \"completed\""),
      "healthcheck rollback should write rollback_status",
    );

    const serviceWhitelist = await createApplySelfTestFixture(
      tempRoot,
      "service-whitelist",
      {
        services: {
          web: { systemd_unit: "gpt2image-web.service" },
          "chatgpt-web-proxy": {
            systemd_unit: "gpt2image-chatgpt-web-proxy.service",
          },
          postgres: { systemd_unit: "postgresql.service" },
        },
      },
    );
    const whitelistError = await invokeApplyFailure(serviceWhitelist, {
      logPath: serviceWhitelist.logPath,
      migrationRunner: async () => ({ status: 0, signal: null, stdout: "", stderr: "" }),
      systemctlRunner: async () => ({ status: 0, signal: null, stdout: "", stderr: "" }),
      healthcheckRunner: async () => ({ ok: true }),
    }, "service whitelist");
    assertSelfTest(
      whitelistError.includes("gpt2image-web.service") ||
        whitelistError.includes("postgresql.service"),
      "service whitelist should reject non-whitelisted unit",
    );

    const symlinkEscapeRoot = path.join(tempRoot, "symlink-escape");
    const symlinkInstallRoot = path.join(symlinkEscapeRoot, "install");
    const outsideRelease = path.join(symlinkEscapeRoot, "outside-release");
    await mkdir(path.join(symlinkInstallRoot, "releases"), { recursive: true });
    await mkdir(outsideRelease, { recursive: true });
    await symlink(
      outsideRelease,
      path.join(symlinkInstallRoot, "current"),
      process.platform === "win32" ? "junction" : "dir",
    );
    try {
      await capturePreviousCurrent({ installRoot: symlinkInstallRoot });
      throw new Error("symlink escape should fail");
    } catch (error) {
      assertSelfTest(
        String(error).includes("outside"),
        "symlink escape should be rejected",
      );
    }

    const staleLock = await createApplySelfTestFixture(tempRoot, "stale-lock");
    const staleLockPath = resolveLockPath(staleLock.installRoot);
    await mkdir(staleLockPath, { recursive: true });
    await writeFile(
      path.join(staleLockPath, "metadata.json"),
      `${JSON.stringify({ pid: 12345, created_at: "2026-06-22T00:00:00.000Z" }, null, 2)}
`,
    );
    const staleLockError = await invokeApplyFailure(staleLock, {
      logPath: staleLock.logPath,
      migrationRunner: async () => ({ status: 0, signal: null, stdout: "", stderr: "" }),
      systemctlRunner: async () => ({ status: 0, signal: null, stdout: "", stderr: "" }),
      healthcheckRunner: async () => ({ ok: true }),
    }, "stale lock");
    assertSelfTest(
      staleLockError.includes("shared/updater.lock"),
      "stale lock should report shared/updater.lock",
    );
    assertSelfTest(await pathExists(staleLockPath), "stale lock should not be deleted");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

/**
 * 主流程。
 * @returns {Promise<void>} 无返回。
 */
async function main() {
  await dispatch(process.argv.slice(2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    console.error(redactSensitiveText(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  });
}
