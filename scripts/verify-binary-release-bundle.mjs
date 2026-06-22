#!/usr/bin/env node
/**
 * 验证 GPT2Image-Pro binary-style release bundle 与 detached manifest。
 * 使用方：release workflow、本地 smoke 和未来 updater 前置校验；脚本只读 artifact，不执行下载、安装、迁移、systemd 切换或重启。
 * 关键依赖：Node.js 内置模块、M1-P1 manifest schema、bundle 文件清单、SHA256SUMS 和 archive checksum。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  listFiles,
  requiredBundlePaths,
  sha256File,
  supportedPlatform,
  verifyBundle,
} from "./binary-style-release-lib.mjs";

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

