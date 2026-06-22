#!/usr/bin/env node
/**
 * GPT2Image-Pro 本地 updater CLI 骨架。
 * 使用方：运维手动 dry-run、后续 Admin/UOL 适配层和 CI smoke；本脚本当前仅做只读预检、计划与状态查看。
 * 关键依赖：Node.js 内置模块、binary-style manifest helper、安装根目录中的 current-version 与 manifest 文件。
 */

import { spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
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
const commandNames = new Set(["check", "download", "plan", "stage", "status", "dry-run"]);
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
const requiredRuntimeEnvNames = ["DATABASE_URL", "BETTER_AUTH_SECRET"];
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
  node scripts/local-updater.mjs --self-test
  node scripts/local-updater.mjs --self-test cli
  node scripts/local-updater.mjs --self-test check

Commands:
  check     Validate a detached manifest without downloading or writing files.
  download  Download or copy an artifact into shared/staging with .partial cleanup and checksum verification.
  plan      Build a read-only update plan for a manifest and install root.
  stage     Extract a verified artifact into shared/staging and run local preflight only.
  status    Read optional current-version and manifest status from install root.
  dry-run   Alias for a full read-only plan; it never switches current or restarts services.

Phase 3 boundary:
  This skeleton never writes releases/current, never runs migrations, never calls systemd, and never performs healthcheck rollback.`;
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
  const version = readManifestString(manifest, "version");
  const safeRunId = runId ?? version;
  assert(!safeRunId.includes(".."), "run-id must not contain path traversal");
  assert(!path.isAbsolute(safeRunId), "run-id must be relative");
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
  assert(!safeRunId.includes(".."), "run-id must not contain path traversal");
  assert(!path.isAbsolute(safeRunId), "run-id must be relative");
  assert(!/^[a-zA-Z]:[\/]/.test(safeRunId), "run-id must not be a drive path");
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
  envFile = "/etc/gpt2image/gpt2image.env",
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
 * 输出 JSON。
 * @param {(message: string) => void} write 输出函数。
 * @param {unknown} value 输出值。
 * @returns {void} 无返回。
 */
function writeJson(write, value) {
  write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * 防止 mutating 命令静默忽略 dry-run 标记。
 * @param {string} command 命令名。
 * @param {Map<string, string | boolean>} args 参数映射。
 * @returns {void} 无返回。
 */
function assertDryRunFlagAllowed(command, args) {
  if ((command === "download" || command === "stage") && args.has("dry-run")) {
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
        selfTest === "stage",
      "--self-test only supports all, cli, check, download, or stage",
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
    await runCliSelfTest();
    await runCheckSelfTest();
    await runDownloadSelfTest();
    await runStageSelfTest();
    write("Local updater self-test passed.\n");
    return;
  }

  if (args.get("help") === true || !command) {
    write(`${formatHelp()}\n`);
    return;
  }

  assert(commandNames.has(command), `Unknown command: ${command}`);
  assertDryRunFlagAllowed(command, args);
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
 * @returns {Promise<void>} 无返回。
 */
async function writeMinimalBundleFixture(bundleDir) {
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
  await writeSelfTestManifest(path.join(bundleDir, "manifest.json"));
  const manifestSha256 = await sha256File(path.join(bundleDir, "manifest.json"));
  await writeFile(path.join(bundleDir, "SHA256SUMS"), `${manifestSha256}  manifest.json
`);
}

/**
 * 创建 tar.gz fixture。
 * @param {string} tempRoot 临时目录。
 * @param {string} bundleName bundle 目录名。
 * @returns {Promise<string>} artifact 路径。
 */
async function createTarFixture(tempRoot, bundleName) {
  const bundleDir = path.join(tempRoot, bundleName);
  await writeMinimalBundleFixture(bundleDir);
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
 * 主流程。
 * @returns {Promise<void>} 无返回。
 */
async function main() {
  await dispatch(process.argv.slice(2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
