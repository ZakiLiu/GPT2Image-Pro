#!/usr/bin/env node
/**
 * 验证 GPT2Image-Pro binary-style release bundle 与 detached manifest。
 * 使用方：release workflow、本地 smoke 和未来 updater 前置校验；脚本只读 artifact，不执行下载、安装、迁移、systemd 切换或重启。
 * 关键依赖：Node.js 内置模块、M1-P1 manifest schema、bundle 文件清单、SHA256SUMS 和 archive checksum。
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const supportedPlatform = "linux-x64";
const expectedManifestFields = [
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
const requiredBundlePaths = [
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
 * 解析命令行参数。
 * @param {string[]} argv 参数。
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
 * 断言值是普通对象。
 * @param {unknown} value 输入。
 * @param {string} label 标签。
 * @returns {Record<string, unknown>} 对象。
 */
function assertObject(value, label) {
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
async function pathExists(filePath) {
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
async function listFiles(baseDir) {
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
 * 读取 JSON 文件并断言根节点为对象。
 * @param {string} filePath 文件路径。
 * @returns {Promise<Record<string, unknown>>} JSON 对象。
 */
async function readJson(filePath) {
  return assertObject(JSON.parse(await readFile(filePath, "utf8")), filePath);
}

/**
 * 验证 manifest schema 仍保留 M1-P1 必需字段和 linux-x64 平台。
 * @returns {Promise<void>} 无返回。
 */
async function verifySchemaBaseline() {
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
function verifyManifest(manifest, expectedPlatform) {
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
async function verifyRequiredPaths(bundleDir) {
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
async function verifyDeniedPaths(bundleDir) {
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
async function verifySha256Sums(bundleDir) {
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
async function verifyArtifact(artifactPath, manifest) {
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
async function verifyBundle({ bundleDir, manifestPath, artifactPath, expectedPlatform }) {
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

/**
 * 写入 fixture 文件。
 * @param {string} filePath 文件路径。
 * @param {string} content 内容。
 * @returns {Promise<void>} 无返回。
 */
async function writeFixture(filePath, content = "fixture") {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
}

/**
 * 创建自测用最小有效 bundle。
 * @param {string} root 临时根目录。
 * @returns {Promise<{ bundleDir: string, manifestPath: string, artifactPath: string }>} fixture 路径。
 */
async function createValidFixture(root) {
  const bundleDir = path.join(root, "bundle");
  for (const requiredPath of requiredBundlePaths) {
    if (requiredPath === "manifest.json" || requiredPath === "SHA256SUMS") {
      continue;
    }
    await writeFixture(path.join(bundleDir, requiredPath));
  }

  const lines = [];
  for (const file of await listFiles(bundleDir)) {
    lines.push(`${await sha256File(file.absolutePath)}  ${file.relativePath}`);
  }
  await writeFile(path.join(bundleDir, "SHA256SUMS"), `${lines.join("\n")}\n`);

  const artifactPath = path.join(root, "artifact.tar.gz");
  await writeFile(artifactPath, "artifact");
  const artifactSha256 = await sha256File(artifactPath);
  const manifest = {
    version: "v0.0.0-alpha.0",
    commit: "0000000000000000000000000000000000000000",
    platform: supportedPlatform,
    artifact_url:
      "https://downloads.example.invalid/gpt2image-pro/v0.0.0-alpha.0/gpt2image-pro-v0.0.0-alpha.0-linux-x64.tar.gz",
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
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestPath = path.join(root, "manifest.json");
  await writeFile(manifestPath, manifestText);
  await writeFile(path.join(bundleDir, "manifest.json"), manifestText);

  return { bundleDir, manifestPath, artifactPath };
}

/**
 * 断言某个自测变体必须失败。
 * @param {string} label 场景名。
 * @param {() => Promise<void>} fn 待执行函数。
 * @returns {Promise<void>} 无返回。
 */
async function expectFailure(label, fn) {
  try {
    await fn();
  } catch {
    return;
  }
  throw new Error(`self-test expected failure but passed: ${label}`);
}

/**
 * 执行负向自测。
 * @returns {Promise<void>} 无返回。
 */
async function runSelfTest() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "gpt2image-binary-verify-"));
  try {
    const valid = await createValidFixture(tempRoot);
    await verifyBundle({ ...valid, expectedPlatform: supportedPlatform });

    await expectFailure("platform mismatch", async () => {
      await verifyBundle({ ...valid, expectedPlatform: "linux-arm64" });
    });

    await expectFailure("artifact_sha256 mismatch", async () => {
      const badArtifact = path.join(tempRoot, "bad-artifact.tar.gz");
      await writeFile(badArtifact, "bad");
      await verifyBundle({
        ...valid,
        artifactPath: badArtifact,
        expectedPlatform: supportedPlatform,
      });
    });

    await expectFailure("missing required file", async () => {
      const missingRoot = await mkdtemp(path.join(tempRoot, "missing-"));
      const fixture = await createValidFixture(missingRoot);
      await rm(path.join(fixture.bundleDir, "bin/chatgpt-web-proxy"));
      await verifyBundle({ ...fixture, expectedPlatform: supportedPlatform });
    });

    await expectFailure("contains .env", async () => {
      const envRoot = await mkdtemp(path.join(tempRoot, "env-"));
      const fixture = await createValidFixture(envRoot);
      await writeFixture(path.join(fixture.bundleDir, ".env"));
      await verifyBundle({ ...fixture, expectedPlatform: supportedPlatform });
    });

    await expectFailure("contains .next/cache", async () => {
      const cacheRoot = await mkdtemp(path.join(tempRoot, "cache-"));
      const fixture = await createValidFixture(cacheRoot);
      await writeFixture(
        path.join(fixture.bundleDir, "apps/web/.next/cache/trace"),
      );
      await verifyBundle({ ...fixture, expectedPlatform: supportedPlatform });
    });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

/**
 * 主流程。
 * @returns {Promise<void>} 无返回。
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.get("self-test") === true) {
    await runSelfTest();
    console.log("Binary release bundle verifier self-test passed.");
    return;
  }

  const bundleDir = readStringArg(args, "bundle-dir");
  const manifestPath = readStringArg(args, "manifest");
  const artifactPath = readStringArg(args, "artifact");
  const expectedPlatform = readStringArg(args, "platform") ?? supportedPlatform;
  if (!bundleDir || !manifestPath) {
    throw new Error("--bundle-dir and --manifest are required unless --self-test is used");
  }

  await verifyBundle({
    bundleDir: path.resolve(bundleDir),
    manifestPath: path.resolve(manifestPath),
    artifactPath: artifactPath ? path.resolve(artifactPath) : undefined,
    expectedPlatform,
  });
  console.log("Binary release bundle verification passed.");
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

