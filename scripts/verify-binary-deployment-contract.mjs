#!/usr/bin/env node
/**
 * 验证 binary-style 部署契约文件是否满足 M1-P1 收口要求。
 * 使用方：开发者在本地或 CI 中手动运行 `pnpm verify:binary-contract`。
 * 关键依赖：仅使用 Node.js 内置模块，读取部署契约文档、manifest schema、manifest 示例与 systemd 模板；不访问网络、不读取运行时 secrets。
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const contractFiles = {
  deploymentDoc: "docs/deployment/binary-style-deployment.md",
  manifestSchema: "docs/deployment/binary-style-manifest.schema.json",
  manifestExample: "docs/deployment/binary-style-manifest.example.json",
  webService: "deploy/systemd/gpt2image-web.service.example",
  proxyService: "deploy/systemd/gpt2image-chatgpt-web-proxy.service.example",
  migrateService: "deploy/systemd/gpt2image-migrate.service.example",
};

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

const sensitiveExampleFiles = [
  contractFiles.manifestExample,
  contractFiles.webService,
  contractFiles.proxyService,
  contractFiles.migrateService,
];

const sensitivePatterns = [
  { label: "DATABASE_URL", pattern: /\bDATABASE_URL\b/i },
  { label: "BETTER_AUTH_SECRET", pattern: /\bBETTER_AUTH_SECRET\b/i },
  { label: "password", pattern: /\bpassword\b/i },
  { label: "token", pattern: /\btoken\b/i },
  {
    label: "secret-like assignment",
    pattern: /\b[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD)[A-Z0-9_]*\s*=/i,
  },
];

const checks = [];
const failures = [];

/**
 * 记录一个验证步骤，失败时保留错误并继续执行后续检查。
 * @param {string} name 验证项名称。
 * @param {() => void | Promise<void>} fn 验证函数。
 * @returns {Promise<void>} 无返回；失败会写入 failures。
 */
async function check(name, fn) {
  try {
    await fn();
    checks.push({ name, status: "pass" });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${name}: ${message}`);
    checks.push({ name, status: "fail" });
  }
}

/**
 * 读取仓库内契约文件。
 * @param {string} relativePath 仓库相对路径。
 * @returns {Promise<string>} 文件内容。
 */
async function readContractText(relativePath) {
  return readFile(path.join(rootDir, relativePath), "utf8");
}

/**
 * 读取并解析 JSON 契约文件。
 * @param {string} relativePath 仓库相对路径。
 * @returns {Promise<unknown>} JSON 对象。
 */
async function readContractJson(relativePath) {
  const text = await readContractText(relativePath);
  return JSON.parse(text);
}

/**
 * 断言条件成立。
 * @param {boolean} condition 条件。
 * @param {string} message 失败说明。
 * @returns {void} 条件不成立时抛错。
 */
function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

/**
 * 断言值是非数组对象，便于后续安全读取字段。
 * @param {unknown} value 待检查值。
 * @param {string} label 错误定位标签。
 * @returns {Record<string, unknown>} 收窄后的对象。
 */
function assertObject(value, label) {
  assert(
    typeof value === "object" && value !== null && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value;
}

/**
 * 断言文本包含所有关键片段。
 * @param {string} text 待检查文本。
 * @param {string[]} snippets 必需片段。
 * @param {string} label 错误定位标签。
 * @returns {void} 缺少片段时抛错。
 */
function assertIncludes(text, snippets, label) {
  const missing = snippets.filter((snippet) => !text.includes(snippet));
  assert(missing.length === 0, `${label} missing: ${missing.join(", ")}`);
}

/**
 * 验证 manifest schema 的根 required 字段与平台枚举。
 * @param {Record<string, unknown>} schema manifest schema。
 * @returns {void} 字段缺失或平台错误时抛错。
 */
function verifySchemaContract(schema) {
  assert(Array.isArray(schema.required), "schema.required must be an array");
  for (const field of expectedManifestFields) {
    assert(
      schema.required.includes(field),
      `schema.required missing ${field}`,
    );
  }

  const properties = assertObject(schema.properties, "schema.properties");
  const platform = assertObject(properties.platform, "schema.properties.platform");
  assert(
    Array.isArray(platform.enum) && platform.enum.includes("linux-x64"),
    "schema platform enum must include linux-x64",
  );

  const artifactSha256 = assertObject(
    properties.artifact_sha256,
    "schema.properties.artifact_sha256",
  );
  assert(
    artifactSha256.pattern === "^[0-9a-fA-F]{64}$",
    "schema artifact_sha256 pattern must require 64 hex chars",
  );
}

/**
 * 验证 manifest example 覆盖必需字段、校验值格式与服务边界。
 * @param {Record<string, unknown>} manifest manifest 示例。
 * @returns {void} 示例不满足契约时抛错。
 */
function verifyManifestExample(manifest) {
  for (const field of expectedManifestFields) {
    assert(
      Object.hasOwn(manifest, field),
      `manifest example missing ${field}`,
    );
  }

  assert(manifest.platform === "linux-x64", "manifest platform must be linux-x64");
  assert(
    typeof manifest.artifact_sha256 === "string" &&
      /^[0-9a-fA-F]{64}$/.test(manifest.artifact_sha256),
    "manifest artifact_sha256 must be 64 hex chars",
  );
  assert(
    typeof manifest.minimum_supported_version === "string" &&
      /^v[0-9]+\.[0-9]+\.[0-9]+(?:-(?:alpha|beta|rc)\.[0-9]+)?$/.test(
        manifest.minimum_supported_version,
      ),
    "manifest minimum_supported_version must use project version format",
  );

  const services = assertObject(manifest.services, "manifest.services");
  const web = assertObject(services.web, "manifest.services.web");
  const proxy = assertObject(
    services["chatgpt-web-proxy"],
    "manifest.services.chatgpt-web-proxy",
  );

  assert(
    web.systemd_unit === "gpt2image-web.service",
    "web service must use gpt2image-web.service",
  );
  assert(
    proxy.systemd_unit === "gpt2image-chatgpt-web-proxy.service",
    "proxy service must use gpt2image-chatgpt-web-proxy.service",
  );
  assert(web.resident === true, "web service must be resident");
  assert(proxy.resident === true, "proxy service must be resident");

  const migration = assertObject(manifest.migration, "manifest.migration");
  assert(migration.resident === false, "migration must not be resident");
}

/**
 * 验证 systemd 示例模板包含服务运行、env、重启与加固关键字段。
 * @param {Record<string, string>} units systemd 模板文本集合。
 * @returns {void} 模板缺少关键字段时抛错。
 */
function verifySystemdTemplates(units) {
  assertIncludes(
    units.web,
    [
      "Description=GPT2Image-Pro Web",
      "WorkingDirectory=/opt/gpt2image/current/apps/web/.next/standalone/apps/web",
      "EnvironmentFile=/etc/gpt2image/gpt2image.env",
      "ExecStart=/usr/bin/node server.js",
      "Restart=on-failure",
      "NoNewPrivileges=true",
      "ReadWritePaths=/opt/gpt2image/shared /var/log/gpt2image",
      "gpt2image-chatgpt-web-proxy.service",
    ],
    "gpt2image-web.service.example",
  );

  assertIncludes(
    units.proxy,
    [
      "Description=GPT2Image-Pro ChatGPT Web proxy",
      "WorkingDirectory=/opt/gpt2image/current",
      "Environment=CHATGPT_WEB_PROXY_BIND=127.0.0.1:3021",
      "EnvironmentFile=/etc/gpt2image/gpt2image.env",
      "ExecStart=/opt/gpt2image/current/bin/chatgpt-web-proxy",
      "Restart=on-failure",
      "NoNewPrivileges=true",
      "ReadWritePaths=/opt/gpt2image/shared /var/log/gpt2image",
    ],
    "gpt2image-chatgpt-web-proxy.service.example",
  );

  assertIncludes(
    units.migrate,
    [
      "Description=GPT2Image-Pro pre-switch migration",
      "Type=oneshot",
      "WorkingDirectory=/opt/gpt2image/current",
      "EnvironmentFile=/etc/gpt2image/gpt2image.env",
      "ExecStart=/usr/bin/env pnpm --dir packages/database db:migrate",
      "RemainAfterExit=no",
      "TimeoutStartSec=300",
      "NoNewPrivileges=true",
    ],
    "gpt2image-migrate.service.example",
  );
}

/**
 * 验证示例型文件不直接携带 secrets 变量或敏感字段。
 * @param {Map<string, string>} files 文件内容映射。
 * @returns {void} 发现敏感片段时抛错。
 */
function verifySecretsBoundary(files) {
  const hits = [];
  for (const [relativePath, text] of files.entries()) {
    for (const { label, pattern } of sensitivePatterns) {
      if (pattern.test(text)) {
        hits.push(`${relativePath} contains ${label}`);
      }
    }
  }

  assert(
    hits.length === 0,
    `example contract files must not contain sensitive fields: ${hits.join("; ")}`,
  );
}

/**
 * 验证叙述性部署文档说明脚本边界与 secrets 边界。
 * @param {string} deploymentDoc 部署契约文档。
 * @returns {void} 文档缺少边界说明时抛错。
 */
function verifyDocumentationBoundary(deploymentDoc) {
  assertIncludes(
    deploymentDoc,
    [
      "当前不表示 binary-style 产物或在线 updater 已经可用",
      "bundle 不包含 secrets",
      "manifest 只记录非敏感元数据",
      "Phase 2 生成的 artifact 必须能离线列出文件清单",
    ],
    contractFiles.deploymentDoc,
  );
}

const schema = assertObject(
  await readContractJson(contractFiles.manifestSchema),
  contractFiles.manifestSchema,
);
const manifest = assertObject(
  await readContractJson(contractFiles.manifestExample),
  contractFiles.manifestExample,
);
const deploymentDoc = await readContractText(contractFiles.deploymentDoc);
const webUnit = await readContractText(contractFiles.webService);
const proxyUnit = await readContractText(contractFiles.proxyService);
const migrateUnit = await readContractText(contractFiles.migrateService);

await check("manifest schema required fields and linux-x64 platform", () => {
  verifySchemaContract(schema);
});

await check("manifest example fields, artifact_sha256, minimum_supported_version", () => {
  verifyManifestExample(manifest);
});

await check("systemd templates for gpt2image-web and gpt2image-chatgpt-web-proxy", () => {
  verifySystemdTemplates({
    web: webUnit,
    proxy: proxyUnit,
    migrate: migrateUnit,
  });
});

await check("example files do not carry secrets, password, token, or env credentials", async () => {
  const files = new Map();
  for (const relativePath of sensitiveExampleFiles) {
    files.set(relativePath, await readContractText(relativePath));
  }
  verifySecretsBoundary(files);
});

await check("deployment documentation states contract and Phase 2 boundary", () => {
  verifyDocumentationBoundary(deploymentDoc);
});

for (const result of checks) {
  console.log(`${result.status.toUpperCase()} ${result.name}`);
}

if (failures.length > 0) {
  console.error("\nBinary deployment contract verification failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log("Binary deployment contract verification passed.");
}
