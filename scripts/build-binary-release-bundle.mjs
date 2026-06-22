#!/usr/bin/env node
/**
 * 组装 GPT2Image-Pro binary-style release bundle。
 * 使用方：release workflow 和本地发布 smoke，通过 `pnpm build:binary-bundle` 调用。
 * 关键依赖：Node.js 内置模块、已完成的 Next standalone 构建、显式传入的 Linux x64 Go sidecar；脚本不读取 `.env`，不执行安装、迁移、systemd 切换或在线更新。
 * CLI 参数：`--version`、`--commit`、`--platform=linux-x64`、`--proxy-binary`、`--out-dir`、`--no-archive`。
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutDir = "dist/binary-style";
const supportedPlatform = "linux-x64";
const versionPattern = /^v\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/;
const commitPattern = /^[0-9a-f]{7,40}$/;
const deniedRootSegments = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".gpt2image",
  "storage",
  "secrets",
  "logs",
]);
const deniedPathFragments = [".next/cache"];
const deniedSuffixes = [".pem", ".key"];

/**
 * 解析命令行参数，支持 `--key value`、`--key=value` 和 `--no-archive`。
 * @param {string[]} argv 原始参数。
 * @returns {Map<string, string | boolean>} 参数映射。
 */
function parseArgs(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected argument: ${token}`);
    }

    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    if (rawKey.startsWith("no-")) {
      args.set(rawKey.slice(3), false);
      continue;
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
  return args;
}

/**
 * 读取字符串参数。
 * @param {Map<string, string | boolean>} args 参数映射。
 * @param {string} key 参数名。
 * @returns {string | undefined} 字符串值。
 */
function readStringArg(args, key) {
  const value = args.get(key);
  if (typeof value === "boolean") {
    throw new Error(`--${key} requires a value`);
  }
  return value;
}

/**
 * 将仓库相对路径转为绝对路径。
 * @param {string} relativePath 仓库相对路径。
 * @returns {string} 绝对路径。
 */
function resolveRoot(relativePath) {
  return path.resolve(rootDir, relativePath);
}

/**
 * 断言路径在父目录内，避免误删或误写仓库外目录。
 * @param {string} child 子路径。
 * @param {string} parent 父路径。
 * @returns {void} 无返回。
 */
function assertInside(child, parent) {
  const relative = path.relative(parent, child);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${child} is outside ${parent}`);
  }
}

/**
 * 判断路径是否存在。
 * @param {string} filePath 文件或目录路径。
 * @returns {Promise<boolean>} 是否存在。
 */
async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取 packageManager 中的 pnpm 版本。
 * @returns {Promise<string>} pnpm 版本。
 */
async function readPnpmVersion() {
  const packageJson = JSON.parse(await readFile(resolveRoot("package.json"), "utf8"));
  if (
    typeof packageJson.packageManager === "string" &&
    packageJson.packageManager.startsWith("pnpm@")
  ) {
    return packageJson.packageManager.slice("pnpm@".length);
  }
  return "10.27.0";
}

/**
 * 解析默认版本，优先使用 tag 名，其次使用 package.json version。
 * @returns {Promise<string>} 版本号。
 */
async function readDefaultVersion() {
  if (process.env.GITHUB_REF_NAME?.startsWith("v")) {
    return process.env.GITHUB_REF_NAME;
  }
  const packageJson = JSON.parse(await readFile(resolveRoot("package.json"), "utf8"));
  return `v${packageJson.version}`;
}

/**
 * 解析默认 commit，优先使用 GitHub Actions 环境变量。
 * @returns {string} commit SHA。
 */
function readDefaultCommit() {
  if (process.env.GITHUB_SHA) {
    return process.env.GITHUB_SHA;
  }
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: rootDir,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error("Cannot resolve git commit. Pass --commit explicitly.");
  }
  return result.stdout.trim();
}

/**
 * 递归复制文件或目录。
 * @param {string} source 源绝对路径。
 * @param {string} target 目标绝对路径。
 * @returns {Promise<void>} 无返回。
 */
async function copyPath(source, target) {
  const sourceStat = await stat(source);
  if (sourceStat.isDirectory()) {
    await mkdir(target, { recursive: true });
    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries) {
      await copyPath(path.join(source, entry.name), path.join(target, entry.name));
    }
    return;
  }

  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
}

/**
 * 检查源路径存在并复制。
 * @param {string} sourceRelative 仓库相对源路径。
 * @param {string} target 目标绝对路径。
 * @returns {Promise<void>} 无返回。
 */
async function copyRequired(sourceRelative, target) {
  const source = resolveRoot(sourceRelative);
  if (!(await pathExists(source))) {
    throw new Error(`Required build input missing: ${sourceRelative}`);
  }
  await copyPath(source, target);
}

/**
 * 递归列出目录中的文件。
 * @param {string} baseDir 根目录。
 * @returns {Promise<Array<{ absolutePath: string; relativePath: string }>>} 文件列表。
 */
async function listFiles(baseDir) {
  const files = [];

  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
      } else if (entry.isFile()) {
        files.push({
          absolutePath,
          relativePath: path.relative(baseDir, absolutePath).replace(/\\/g, "/"),
        });
      }
    }
  }

  await walk(baseDir);
  return files;
}

/**
 * 判断 bundle 相对路径是否命中禁入规则。
 * @param {string} relativePath bundle 相对路径。
 * @returns {boolean} 是否禁入。
 */
function isDeniedBundlePath(relativePath) {
  const normalizedPath = relativePath.replace(/\\/g, "/");
  const [rootSegment] = normalizedPath.split("/");
  return (
    deniedPathFragments.some((fragment) => normalizedPath.includes(fragment)) ||
    deniedRootSegments.has(rootSegment) ||
    deniedSuffixes.some((suffix) => normalizedPath.endsWith(suffix))
  );
}

/**
 * 扫描 bundle，发现运行态目录或敏感文件路径时失败。
 * @param {string} bundleDir bundle 根目录。
 * @returns {Promise<void>} 无返回。
 */
async function assertNoDeniedBundlePaths(bundleDir) {
  const denied = (await listFiles(bundleDir))
    .map((file) => file.relativePath)
    .filter((relativePath) => isDeniedBundlePath(relativePath));
  if (denied.length > 0) {
    throw new Error(`Denied paths in bundle: ${denied.join(", ")}`);
  }
}

/**
 * 计算文件 SHA256。
 * @param {string} filePath 文件路径。
 * @returns {Promise<string>} hex digest。
 */
async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", resolve);
  });
  return hash.digest("hex");
}

/**
 * 写入 bundle 内文件清单 checksum，排除 manifest 与 SHA256SUMS 自身。
 * @param {string} bundleDir bundle 根目录。
 * @returns {Promise<void>} 无返回。
 */
async function writeBundleSha256Sums(bundleDir) {
  const lines = [];
  for (const file of await listFiles(bundleDir)) {
    if (file.relativePath === "manifest.json" || file.relativePath === "SHA256SUMS") {
      continue;
    }
    lines.push(`${await sha256File(file.absolutePath)}  ${file.relativePath}`);
  }
  await writeFile(path.join(bundleDir, "SHA256SUMS"), `${lines.join("\n")}\n`);
}

/**
 * 写入 migrator 运行边界说明，说明目标机不需要仓库源码。
 * @param {string} migratorDir migrator 目录。
 * @returns {Promise<void>} 无返回。
 */
async function writeMigratorRuntimeDoc(migratorDir) {
  const pnpmVersion = await readPnpmVersion();
  const content = [
    "# Migrator bundle runtime",
    "",
    "This directory is the self-contained database migration boundary for the binary-style bundle.",
    "The target host does not need a Git checkout or repository source tree.",
    "",
    "Prerequisites:",
    "",
    "- Node.js 22 runtime.",
    `- Corepack with pnpm ${pnpmVersion} enabled.`,
    "- Runtime database connection provided by `/etc/gpt2image/gpt2image.env` or the calling environment.",
    "",
    "Run from this directory after unpacking and before switching current symlink:",
    "",
    "```bash",
    "corepack enable",
    "pnpm install --frozen-lockfile --prod=false",
    "pnpm --dir packages/database db:migrate",
    "```",
    "",
    "The migrator is a pre-switch one-shot step. It is not a resident service and does not promise automatic database rollback.",
    "",
  ].join("\n");
  await writeFile(path.join(migratorDir, "RUNTIME.md"), content);
}

/**
 * 组装 bundle 目录。
 * @param {object} params 参数。
 * @param {string} params.bundleDir bundle 目录。
 * @param {string} params.proxyBinary Go sidecar binary。
 * @returns {Promise<void>} 无返回。
 */
async function assembleBundle({ bundleDir, proxyBinary }) {
  await copyRequired("apps/web/.next/standalone", path.join(bundleDir, "apps/web/.next/standalone"));
  await copyRequired("apps/web/.next/static", path.join(bundleDir, "apps/web/.next/static"));
  await copyRequired("apps/web/public", path.join(bundleDir, "apps/web/public"));

  const proxyTarget = path.join(bundleDir, "bin/chatgpt-web-proxy");
  await copyPath(path.resolve(proxyBinary), proxyTarget);
  await chmod(proxyTarget, 0o755);

  const scriptsDir = path.join(bundleDir, "scripts");
  await copyRequired(
    "scripts/local-updater.mjs",
    path.join(scriptsDir, "local-updater.mjs"),
  );
  await copyRequired(
    "scripts/binary-style-release-lib.mjs",
    path.join(scriptsDir, "binary-style-release-lib.mjs"),
  );

  const migratorDir = path.join(bundleDir, "migrator");
  await copyRequired("package.json", path.join(migratorDir, "package.json"));
  await copyRequired("pnpm-lock.yaml", path.join(migratorDir, "pnpm-lock.yaml"));
  await copyRequired("pnpm-workspace.yaml", path.join(migratorDir, "pnpm-workspace.yaml"));
  await copyRequired("tsconfig.base.json", path.join(migratorDir, "tsconfig.base.json"));
  await copyRequired("packages/database/package.json", path.join(migratorDir, "packages/database/package.json"));
  await copyRequired("packages/database/drizzle.config.ts", path.join(migratorDir, "packages/database/drizzle.config.ts"));
  await copyRequired("packages/database/drizzle", path.join(migratorDir, "packages/database/drizzle"));
  await copyRequired("packages/database/src", path.join(migratorDir, "packages/database/src"));
  await copyRequired("packages/database/tsconfig.json", path.join(migratorDir, "packages/database/tsconfig.json"));
  await writeMigratorRuntimeDoc(migratorDir);

  await copyRequired("deploy/systemd", path.join(bundleDir, "deploy/systemd"));
  await copyRequired("docs/deployment/binary-style-deployment.md", path.join(bundleDir, "docs/deployment/binary-style-deployment.md"));
  await copyRequired("docs/deployment/binary-style-manifest.schema.json", path.join(bundleDir, "docs/deployment/binary-style-manifest.schema.json"));
}

/**
 * 创建 manifest 对象。artifact_sha256 在创建 archive 后由 detached manifest 写入真实值。
 * @param {object} params 参数。
 * @param {string} params.version 版本。
 * @param {string} params.commit commit SHA。
 * @param {string} params.artifactUrl artifact URL。
 * @param {string} params.artifactSha256 tar.gz SHA256。
 * @returns {object} manifest。
 */
function createManifest({ version, commit, artifactUrl, artifactSha256 }) {
  return {
    version,
    commit,
    platform: supportedPlatform,
    artifact_url: artifactUrl,
    artifact_sha256: artifactSha256,
    minimum_supported_version: "v0.5.0",
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
    migration: {
      runner: "migrator",
      lifecycle: "one-shot",
      mode_source: "migration_mode",
      resident: false,
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
  };
}

/**
 * 使用系统 tar 创建 gzip 压缩包。CI 和 Debian 目标平台均提供 tar。
 * @param {string} versionDir 版本输出目录。
 * @param {string} bundleName bundle 顶层目录名。
 * @param {string} tarPath 输出 tar.gz。
 * @returns {void} 无返回。
 */
function createTarGz(versionDir, bundleName, tarPath) {
  const result = spawnSync("tar", ["-czf", tarPath, "-C", versionDir, bundleName], {
    cwd: rootDir,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`tar failed: ${result.stderr || result.stdout}`);
  }
}

const crcTable = new Uint32Array(256).map((_, tableIndex) => {
  let value = tableIndex;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

/**
 * 计算 zip store 模式所需 CRC32。
 * @param {Buffer} buffer 文件内容。
 * @returns {number} CRC32。
 */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 写入 buffer 并累计偏移。
 * @param {object} context 写入上下文。
 * @param {import("node:fs").WriteStream} context.output 输出流。
 * @param {number} context.offset 当前偏移。
 * @param {Buffer} chunk 写入块。
 * @returns {number} 新偏移。
 */
function writeZipChunk(context, chunk) {
  context.output.write(chunk);
  return context.offset + chunk.length;
}

/**
 * 创建无压缩 zip archive，避免引入第三方压缩依赖。
 * @param {string} bundleDir bundle 目录。
 * @param {string} bundleName bundle 顶层目录名。
 * @param {string} outputPath 输出 zip。
 * @returns {Promise<void>} 无返回。
 */
async function createZip(bundleDir, bundleName, outputPath) {
  const output = createWriteStream(outputPath);
  const context = { output, offset: 0 };
  const centralDirectory = [];

  for (const file of await listFiles(bundleDir)) {
    const content = await readFile(file.absolutePath);
    const nameBuffer = Buffer.from(`${bundleName}/${file.relativePath}`, "utf8");
    const crc = crc32(content);
    const localOffset = context.offset;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    context.offset = writeZipChunk(context, local);
    context.offset = writeZipChunk(context, nameBuffer);
    context.offset = writeZipChunk(context, content);

    centralDirectory.push({
      nameBuffer,
      crc,
      size: content.length,
      localOffset,
      mode: file.relativePath === "bin/chatgpt-web-proxy" ? 0o755 : 0o644,
    });
  }

  const centralStart = context.offset;
  for (const entry of centralDirectory) {
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(entry.crc, 16);
    central.writeUInt32LE(entry.size, 20);
    central.writeUInt32LE(entry.size, 24);
    central.writeUInt16LE(entry.nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((entry.mode << 16) >>> 0, 38);
    central.writeUInt32LE(entry.localOffset, 42);
    context.offset = writeZipChunk(context, central);
    context.offset = writeZipChunk(context, entry.nameBuffer);
  }

  const centralSize = context.offset - centralStart;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(centralDirectory.length, 8);
  end.writeUInt16LE(centralDirectory.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);
  context.offset = writeZipChunk(context, end);

  await new Promise((resolve, reject) => {
    output.end(resolve);
    output.on("error", reject);
  });
}

/**
 * 写入 archive checksum 文件。
 * @param {string} archivePath archive 路径。
 * @returns {Promise<string>} archive hash。
 */
async function writeArchiveSha256(archivePath) {
  const digest = await sha256File(archivePath);
  const checksumTarget = path.relative(rootDir, archivePath).replace(/\\/g, "/");
  await writeFile(`${archivePath}.sha256`, `${digest}  ${checksumTarget}\n`);
  return digest;
}

/**
 * 主流程。
 * @returns {Promise<void>} 无返回。
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = readStringArg(args, "version") ?? (await readDefaultVersion());
  const commit = readStringArg(args, "commit") ?? readDefaultCommit();
  const requestedPlatform = readStringArg(args, "platform") ?? supportedPlatform;
  const outDir = path.resolve(readStringArg(args, "out-dir") ?? resolveRoot(defaultOutDir));
  const proxyBinary = path.resolve(
    readStringArg(args, "proxy-binary") ??
      resolveRoot("dist/binary-style/build/chatgpt-web-proxy"),
  );
  const archiveEnabled = args.get("archive") !== false;

  if (!versionPattern.test(version)) {
    throw new Error(`Invalid version: ${version}`);
  }
  if (!commitPattern.test(commit)) {
    throw new Error(`Invalid commit: ${commit}`);
  }
  if (requestedPlatform !== supportedPlatform) {
    throw new Error(`Unsupported platform: ${requestedPlatform}`);
  }
  if (!(await pathExists(proxyBinary))) {
    throw new Error(`Proxy binary not found: ${proxyBinary}`);
  }

  const bundleName = `gpt2image-pro-${version}-${supportedPlatform}`;
  const versionDir = path.join(outDir, version);
  const bundleDir = path.join(versionDir, bundleName);
  assertInside(versionDir, outDir);

  await rm(versionDir, { recursive: true, force: true });
  await mkdir(bundleDir, { recursive: true });
  await assembleBundle({ bundleDir, proxyBinary });
  await assertNoDeniedBundlePaths(bundleDir);

  const artifactUrl =
    readStringArg(args, "artifact-url") ??
    `https://github.com/${process.env.GITHUB_REPOSITORY ?? "MeowFree/GPT2Image-Pro"}/releases/download/${version}/${bundleName}.tar.gz`;
  const placeholderManifest = createManifest({
    version,
    commit,
    artifactUrl,
    artifactSha256: "0".repeat(64),
  });
  await writeFile(
    path.join(bundleDir, "manifest.json"),
    `${JSON.stringify(placeholderManifest, null, 2)}\n`,
  );
  await writeBundleSha256Sums(bundleDir);

  const tarPath = path.join(versionDir, `${bundleName}.tar.gz`);
  const zipPath = path.join(versionDir, `${bundleName}.zip`);
  let tarSha256 = "0".repeat(64);
  let zipSha256 = "0".repeat(64);
  if (archiveEnabled) {
    createTarGz(versionDir, bundleName, tarPath);
    await createZip(bundleDir, bundleName, zipPath);
    tarSha256 = await writeArchiveSha256(tarPath);
    zipSha256 = await writeArchiveSha256(zipPath);
  }

  const detachedManifest = createManifest({
    version,
    commit,
    artifactUrl,
    artifactSha256: tarSha256,
  });
  const detachedManifestPath = path.join(versionDir, "manifest.json");
  await writeFile(detachedManifestPath, `${JSON.stringify(detachedManifest, null, 2)}\n`);
  await writeFile(
    path.join(versionDir, "SHA256SUMS"),
    `${[
      archiveEnabled ? `${tarSha256}  ${bundleName}.tar.gz` : undefined,
      archiveEnabled ? `${zipSha256}  ${bundleName}.zip` : undefined,
      `${await sha256File(detachedManifestPath)}  manifest.json`,
    ]
      .filter(Boolean)
      .join("\n")}\n`,
  );

  console.log(`Binary-style bundle written to ${path.relative(rootDir, versionDir)}`);
  console.log(`Bundle directory: ${path.relative(rootDir, bundleDir)}`);
  if (archiveEnabled) {
    console.log(`Archive: ${path.relative(rootDir, tarPath)} ${tarSha256}`);
    console.log(`Archive: ${path.relative(rootDir, zipPath)} ${zipSha256}`);
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});


