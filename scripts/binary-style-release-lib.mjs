#!/usr/bin/env node
/**
 * 复用 GPT2Image-Pro binary-style release artifact 校验 helper。
 * 使用方：release bundle verifier、本地 updater core 和未来只读 artifact 预检；本文件不提供 CLI，不执行下载、安装、迁移、systemd 切换或重启。
 * 关键依赖：Node.js 内置模块、M1-P1 manifest schema、bundle 文件清单、SHA256SUMS 和 archive checksum。
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const supportedPlatform = "linux-x64";
export const expectedManifestFields = [
  "version",
  "commit",
  "platform",
  "artifact_url",
  "artifact_sha256",
  "minimum_supported_version",
  "migration_mode",
  "services",
  "healthcheck",
];
export const requiredBundlePaths = [
  "apps/web/.next/standalone/apps/web/server.js",
  "apps/web/.next/static",
  "apps/web/public",
  "migrator/package.json",
  "migrator/pnpm-lock.yaml",
  "migrator/pnpm-workspace.yaml",
  "migrator/tsconfig.base.json",
  "migrator/packages/database/package.json",
  "migrator/packages/database/drizzle.config.ts",
  "migrator/packages/database/drizzle/meta/_journal.json",
  "migrator/packages/database/src",
  "migrator/packages/database/tsconfig.json",
  "migrator/RUNTIME.md",
  "bin/chatgpt-web-proxy",
  "deploy/systemd/gpt2image-web.service.example",
  "deploy/systemd/gpt2image-chatgpt-web-proxy.service.example",
  "deploy/systemd/gpt2image-migrate.service.example",
  "docs/deployment/binary-style-deployment.md",
  "docs/deployment/binary-style-manifest.schema.json",
  "manifest.json",
  "SHA256SUMS",
];
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
 * 断言条件成立。
 * @param {boolean} condition 条件。
 * @param {string} message 错误消息。
 * @returns {void} 无返回。
 */
export function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

/**
 * 断言值是普通对象。
 * @param {unknown} value 输入。
 * @param {string} label 标签。
 * @returns {Record<string, unknown>} 对象。
 */
export function assertObject(value, label) {
  assert(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value;
}

/**
 * 判断路径是否存在。
 * @param {string} filePath 文件或目录路径。
 * @returns {Promise<boolean>} 是否存在。
 */
export async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * 递归列出目录文件。
 * @param {string} baseDir 根目录。
 * @returns {Promise<Array<{ absolutePath: string, relativePath: string }>>} 文件列表。
 */
export async function listFiles(baseDir) {
  const files = [];

  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
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
export function isDeniedBundlePath(relativePath) {
  const normalizedPath = relativePath.replace(/\\/g, "/");
  const [rootSegment] = normalizedPath.split("/");
  return (
    deniedPathFragments.some((fragment) => normalizedPath.includes(fragment)) ||
    deniedRootSegments.has(rootSegment) ||
    deniedSuffixes.some((suffix) => normalizedPath.endsWith(suffix))
  );
}

/**
 * 计算文件 SHA256。
 * @param {string} filePath 文件路径。
 * @returns {Promise<string>} hex digest。
 */
export async function sha256File(filePath) {
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
 * 读取 JSON 文件并断言根节点为对象。
 * @param {string} filePath 文件路径。
 * @returns {Promise<Record<string, unknown>>} JSON 对象。
 */
export async function readJson(filePath) {
  return assertObject(JSON.parse(await readFile(filePath, "utf8")), filePath);
}

/**
 * 验证 manifest schema 仍保留 M1-P1 必需字段和 linux-x64 平台。
 * @returns {Promise<void>} 无返回。
 */
export async function verifySchemaBaseline() {
  const schema = await readJson(
    path.join(rootDir, "docs/deployment/binary-style-manifest.schema.json"),
  );
  assert(Array.isArray(schema.required), "schema.required must be an array");
  for (const field of expectedManifestFields) {
    assert(schema.required.includes(field), `schema.required missing ${field}`);
  }

  const properties = assertObject(schema.properties, "schema.properties");
  const platform = assertObject(
    properties.platform,
    "schema.properties.platform",
  );
  assert(
    Array.isArray(platform.enum) && platform.enum.includes(supportedPlatform),
    "schema platform enum must include linux-x64",
  );
}

/**
 * 验证 manifest 强约束。
 * @param {Record<string, unknown>} manifest manifest。
 * @param {string} expectedPlatform 期望平台。
 * @returns {void} 无返回。
 */
export function verifyManifest(manifest, expectedPlatform) {
  for (const field of expectedManifestFields) {
    assert(Object.hasOwn(manifest, field), `manifest missing ${field}`);
  }
  assert(
    manifest.platform === expectedPlatform,
    `manifest platform must be ${expectedPlatform}`,
  );
  assert(
    typeof manifest.artifact_sha256 === "string" &&
      /^[0-9a-fA-F]{64}$/.test(manifest.artifact_sha256),
    "manifest artifact_sha256 must be 64 hex chars",
  );

  const services = assertObject(manifest.services, "manifest.services");
  const web = assertObject(services.web, "manifest.services.web");
  const proxy = assertObject(
    services["chatgpt-web-proxy"],
    "manifest.services.chatgpt-web-proxy",
  );
  assert(web.systemd_unit === "gpt2image-web.service", "web systemd unit mismatch");
  assert(
    proxy.systemd_unit === "gpt2image-chatgpt-web-proxy.service",
    "proxy systemd unit mismatch",
  );

  const healthcheck = assertObject(manifest.healthcheck, "manifest.healthcheck");
  assertObject(healthcheck.web, "manifest.healthcheck.web");
  assertObject(
    healthcheck["chatgpt-web-proxy"],
    "manifest.healthcheck.chatgpt-web-proxy",
  );
}

/**
 * 验证 bundle 必需路径存在。
 * @param {string} bundleDir bundle 目录。
 * @returns {Promise<void>} 无返回。
 */
export async function verifyRequiredPaths(bundleDir) {
  for (const relativePath of requiredBundlePaths) {
    assert(
      await pathExists(path.join(bundleDir, relativePath)),
      `bundle missing required path: ${relativePath}`,
    );
  }
}

/**
 * 验证 bundle 没有敏感文件或运行态目录。
 * @param {string} bundleDir bundle 目录。
 * @returns {Promise<void>} 无返回。
 */
export async function verifyDeniedPaths(bundleDir) {
  const denied = (await listFiles(bundleDir))
    .map((file) => file.relativePath)
    .filter((relativePath) => isDeniedBundlePath(relativePath));
  assert(denied.length === 0, `bundle contains denied paths: ${denied.join(", ")}`);
}

/**
 * 验证 bundle 内 SHA256SUMS。
 * @param {string} bundleDir bundle 目录。
 * @returns {Promise<void>} 无返回。
 */
export async function verifySha256Sums(bundleDir) {
  const text = await readFile(path.join(bundleDir, "SHA256SUMS"), "utf8");
  const seen = new Set();
  for (const [index, line] of text.trim().split(/\r?\n/).entries()) {
    const match = /^([0-9a-fA-F]{64})\s{2}(.+)$/.exec(line);
    assert(Boolean(match), `SHA256SUMS line ${index + 1} has invalid format`);
    const expected = match[1].toLowerCase();
    const relativePath = match[2];
    assert(!seen.has(relativePath), `SHA256SUMS duplicate path: ${relativePath}`);
    seen.add(relativePath);
    const absolutePath = path.join(bundleDir, relativePath);
    assert(await pathExists(absolutePath), `SHA256SUMS references missing file: ${relativePath}`);
    const actual = await sha256File(absolutePath);
    assert(actual === expected, `SHA256 mismatch for ${relativePath}`);
  }
}

/**
 * 验证 archive hash 与 detached manifest artifact_sha256 一致。
 * @param {string | undefined} artifactPath artifact 路径。
 * @param {Record<string, unknown>} manifest manifest。
 * @returns {Promise<void>} 无返回。
 */
export async function verifyArtifact(artifactPath, manifest) {
  if (!artifactPath) {
    return;
  }
  assert(await pathExists(artifactPath), `artifact not found: ${artifactPath}`);
  const actual = await sha256File(artifactPath);
  assert(
    actual === String(manifest.artifact_sha256).toLowerCase(),
    "artifact sha256 mismatch",
  );
}

/**
 * 完整验证 bundle、manifest、archive 和 SHA256SUMS。
 * @param {object} params 参数。
 * @param {string} params.bundleDir bundle 目录。
 * @param {string} params.manifestPath detached manifest。
 * @param {string | undefined} params.artifactPath archive。
 * @param {string} params.expectedPlatform 平台。
 * @returns {Promise<void>} 无返回。
 */
export async function verifyBundle({ bundleDir, manifestPath, artifactPath, expectedPlatform }) {
  await verifySchemaBaseline();
  const manifest = await readJson(manifestPath);
  verifyManifest(manifest, expectedPlatform);
  await verifyArtifact(artifactPath, manifest);
  await verifyRequiredPaths(bundleDir);
  await verifyDeniedPaths(bundleDir);
  await verifySha256Sums(bundleDir);

  const internalManifest = await readJson(path.join(bundleDir, "manifest.json"));
  verifyManifest(internalManifest, expectedPlatform);
}
