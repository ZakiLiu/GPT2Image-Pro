/**
 * Admin updater wrapper - 仅服务端可用的本地 updater 适配层。
 *
 * 职责：把 UOL update.* operation 绑定到本机 `scripts/local-updater.mjs`，并统一处理
 * 默认关闭、固定 argv、无 shell 调用、输出脱敏与 JSON 解析。
 * 使用方：`apps/web/src/server/uol-bindings.ts` 通过 late binding 调用本模块。
 * 关键依赖：Node.js child_process、服务端环境变量、shared UOL OperationError。
 *
 * 安全边界：请求输入不得覆盖 UPDATER_SCRIPT_PATH、UPDATER_INSTALL_ROOT 或
 * UPDATER_ENV_FILE；这些运行时路径只能来自服务端环境变量。
 */
import { spawn } from "node:child_process";
import path from "node:path";

import { OperationError } from "@repo/shared/uol";

const defaultPlatform = "linux-x64";
const defaultTimeoutMs = 120_000;
const maxTimeoutMs = 600_000;
const truthyValues = new Set(["1", "true", "yes", "on", "enabled"]);
const sensitiveEnvNames = [
  "DATABASE_URL",
  "BETTER_AUTH_SECRET",
  "CHATGPT_WEB_PROXY_SECRET",
  "MCP_ADMIN_SECRET",
  "UPDATER_ENV_FILE",
];

export interface UpdateStatusInput {
  installRoot?: string;
}

export interface UpdateCheckInput {
  manifestPath?: string;
  currentVersion?: string;
  installRoot?: string;
  platform?: string;
}

export interface UpdateApplyInput {
  manifestPath: string;
  artifactPath: string;
  runId: string;
  confirmVersion: string;
  installRoot?: string;
  envFile?: string;
  platform?: string;
}

export interface LocalUpdaterRunnerResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface LocalUpdaterRunnerOptions {
  timeoutMs: number;
}

type UpdaterEnv = Record<string, string | undefined>;

export type LocalUpdaterRunner = (
  command: string,
  args: string[],
  options: LocalUpdaterRunnerOptions
) => Promise<LocalUpdaterRunnerResult>;

interface UpdaterConfig {
  enabled: boolean;
  scriptPath?: string;
  installRoot?: string;
  envFile?: string;
  manifestPath?: string;
  timeoutMs: number;
  configured: boolean;
  disabledReason?: string;
}

interface UpdaterServiceOptions {
  env?: UpdaterEnv;
  runner?: LocalUpdaterRunner;
}

interface StatusFileSummary {
  path: string;
  exists: boolean;
  value?: string;
}

interface ManifestSummary {
  path: string;
  exists: boolean;
  version?: string;
  platform?: string;
}

export interface UpdateStatusOutput {
  installRoot: string;
  dryRun: boolean;
  files: {
    currentVersion: StatusFileSummary;
    rootManifest: ManifestSummary;
    currentManifest: ManifestSummary;
  };
  enabled: boolean;
  configured: boolean;
  scriptPathConfigured: boolean;
  installRootConfigured: boolean;
  envFileConfigured: boolean;
  disabledReason?: string;
  lastKnownCurrentVersion?: string;
  [key: string]: unknown;
}

export interface UpdateCheckOutput {
  command: "check";
  dryRun: boolean;
  manifest: string;
  platform: string;
  ok: boolean;
  current_version: string | null;
  available_version: string;
  minimum_supported_version: string;
  decision: string;
  reason: string;
  artifact_url: string;
  artifact_sha256: string;
  enabled: boolean;
  configured: boolean;
  disabledReason?: string;
  [key: string]: unknown;
}

export interface UpdateApplyOutput {
  command?: "apply" | "update";
  ok?: boolean;
  runId?: string;
  status?: string;
  version?: string;
  apply_json?: string;
  rollback_status?: string;
  healthcheck_status?: string;
  [key: string]: unknown;
}

/**
 * 创建可注入 runner/env 的 updater service，便于 Vitest 在无真实进程和无生产 env 下测试。
 */
export function createUpdaterAdminService(options: UpdaterServiceOptions = {}) {
  const env = options.env ?? process.env;
  const runner = options.runner ?? runLocalUpdaterProcess;

  return {
    getUpdaterStatus(input: UpdateStatusInput = {}) {
      return getUpdaterStatusWithDeps(input, env, runner);
    },
    checkUpdater(input: UpdateCheckInput = {}) {
      return checkUpdaterWithDeps(input, env, runner);
    },
    applyUpdater(input: UpdateApplyInput) {
      return applyUpdaterWithDeps(input, env, runner);
    },
  };
}

/** 读取本机 updater 状态。 */
export async function getUpdaterStatus(
  input: UpdateStatusInput = {}
): Promise<UpdateStatusOutput> {
  return createUpdaterAdminService().getUpdaterStatus(input);
}

/** 检查 manifest 中是否存在可升级版本。 */
export async function checkUpdater(
  input: UpdateCheckInput = {}
): Promise<UpdateCheckOutput> {
  return createUpdaterAdminService().checkUpdater(input);
}

/** 执行 destructive 在线更新。 */
export async function applyUpdater(
  input: UpdateApplyInput
): Promise<UpdateApplyOutput> {
  return createUpdaterAdminService().applyUpdater(input);
}

/** 默认 runner：固定使用当前 Node 可执行文件、shell:false 和隐藏窗口。 */
async function runLocalUpdaterProcess(
  command: string,
  args: string[],
  options: LocalUpdaterRunnerOptions
): Promise<LocalUpdaterRunnerResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({
        status: timedOut && status === null ? 124 : status,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

async function getUpdaterStatusWithDeps(
  input: UpdateStatusInput,
  env: UpdaterEnv,
  runner: LocalUpdaterRunner
): Promise<UpdateStatusOutput> {
  rejectServerPathOverrides(input);
  const config = readUpdaterConfig(env);
  if (
    !config.enabled ||
    !config.configured ||
    !config.installRoot ||
    !config.scriptPath
  ) {
    return buildStatusSummary(config);
  }

  const runnableConfig = {
    ...config,
    installRoot: config.installRoot,
    scriptPath: config.scriptPath,
  };
  const output = await runUpdaterJson(runnableConfig, runner, [
    "status",
    "--install-root",
    runnableConfig.installRoot,
  ]);
  return normalizeStatusOutput(output, runnableConfig);
}

async function checkUpdaterWithDeps(
  input: UpdateCheckInput,
  env: UpdaterEnv,
  runner: LocalUpdaterRunner
): Promise<UpdateCheckOutput> {
  rejectServerPathOverrides(input);
  const config = readUpdaterConfig(env);
  const manifestPath =
    trimToUndefined(input.manifestPath) ?? config.manifestPath;
  const platform = trimToUndefined(input.platform) ?? defaultPlatform;

  const installRoot = config.installRoot;
  if (
    !config.enabled ||
    !config.configured ||
    !installRoot ||
    !config.scriptPath ||
    !manifestPath
  ) {
    return buildDisabledCheckOutput({
      config,
      manifestPath,
      platform,
      currentVersion: trimToUndefined(input.currentVersion),
      reason:
        config.disabledReason ??
        (!manifestPath
          ? "UPDATER_MANIFEST_PATH or manifestPath is required"
          : undefined),
    });
  }

  const runnableConfig = {
    ...config,
    installRoot,
    scriptPath: config.scriptPath,
  };
  const args = buildCheckArgs({
    config: runnableConfig,
    manifestPath,
    platform,
    currentVersion: trimToUndefined(input.currentVersion),
  });
  const output = await runUpdaterJson(runnableConfig, runner, args);
  return normalizeCheckOutput(output, runnableConfig);
}

async function applyUpdaterWithDeps(
  input: UpdateApplyInput,
  env: UpdaterEnv,
  runner: LocalUpdaterRunner
): Promise<UpdateApplyOutput> {
  rejectServerPathOverrides(input);
  const config = readUpdaterConfig(env);
  assertApplyEnabled(config);

  const manifestPath = requireNonEmpty(input.manifestPath, "manifestPath");
  const artifactPath = requireNonEmpty(input.artifactPath, "artifactPath");
  const runId = requireNonEmpty(input.runId, "runId");
  const confirmVersion = requireNonEmpty(
    input.confirmVersion,
    "confirmVersion"
  );
  const platform = trimToUndefined(input.platform) ?? defaultPlatform;

  const checkOutput = await runUpdaterJson(
    config,
    runner,
    buildCheckArgs({ config, manifestPath, platform })
  );
  const availableVersion = readStringField(checkOutput, "available_version");
  if (availableVersion !== confirmVersion) {
    throw new OperationError(
      "validation_error",
      "confirmVersion does not match manifest available_version",
      { confirmVersion, availableVersion }
    );
  }

  const output = await runUpdaterJson(config, runner, [
    "apply",
    "--install-root",
    config.installRoot,
    "--manifest",
    manifestPath,
    "--env-file",
    config.envFile,
    "--artifact-file",
    artifactPath,
    "--run-id",
    runId,
    "--platform",
    platform,
  ]);

  return {
    ...output,
    runId,
  };
}

function readUpdaterConfig(env: UpdaterEnv): UpdaterConfig {
  const enabled = truthyValues.has(
    (trimToUndefined(env.UPDATER_ENABLED) ?? "").toLowerCase()
  );
  const scriptPath = trimToUndefined(env.UPDATER_SCRIPT_PATH);
  const installRoot = trimToUndefined(env.UPDATER_INSTALL_ROOT);
  const envFile = trimToUndefined(env.UPDATER_ENV_FILE);
  const manifestPath = trimToUndefined(env.UPDATER_MANIFEST_PATH);
  const timeoutMs = readTimeoutMs(env.UPDATER_TIMEOUT_MS);
  const configured = Boolean(scriptPath && installRoot && envFile);
  return {
    enabled,
    scriptPath,
    installRoot,
    envFile,
    manifestPath,
    timeoutMs,
    configured,
    disabledReason: buildDisabledReason({
      enabled,
      scriptPath,
      installRoot,
      envFile,
    }),
  };
}

function readTimeoutMs(rawValue: string | undefined): number {
  const raw = trimToUndefined(rawValue);
  if (!raw) return defaultTimeoutMs;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maxTimeoutMs) {
    return defaultTimeoutMs;
  }
  return parsed;
}

function buildDisabledReason(input: {
  enabled: boolean;
  scriptPath?: string;
  installRoot?: string;
  envFile?: string;
}): string | undefined {
  if (!input.enabled) return "UPDATER_ENABLED is not truthy";
  if (!input.scriptPath) return "UPDATER_SCRIPT_PATH is required";
  if (!input.installRoot) return "UPDATER_INSTALL_ROOT is required";
  if (!input.envFile) return "UPDATER_ENV_FILE is required for apply";
  return undefined;
}

function rejectServerPathOverrides(input: {
  installRoot?: string;
  envFile?: string;
}): void {
  if (input.installRoot !== undefined) {
    throw new OperationError(
      "validation_error",
      "UPDATER_INSTALL_ROOT is server-configured and cannot be overridden by input"
    );
  }
  if (input.envFile !== undefined) {
    throw new OperationError(
      "validation_error",
      "UPDATER_ENV_FILE is server-configured and cannot be overridden by input"
    );
  }
}

function assertApplyEnabled(
  config: UpdaterConfig
): asserts config is UpdaterConfig & {
  scriptPath: string;
  installRoot: string;
  envFile: string;
} {
  if (!config.enabled) {
    throw new OperationError(
      "forbidden",
      "Updater is disabled; set UPDATER_ENABLED to a truthy value on the server"
    );
  }
  if (!config.scriptPath || !config.installRoot || !config.envFile) {
    throw new OperationError(
      "validation_error",
      config.disabledReason ?? "Updater is not fully configured"
    );
  }
}

function buildCheckArgs(input: {
  config: UpdaterConfig & { installRoot: string };
  manifestPath: string;
  platform: string;
  currentVersion?: string;
}): string[] {
  const args = [
    "check",
    "--manifest",
    input.manifestPath,
    "--platform",
    input.platform,
    "--install-root",
    input.config.installRoot,
  ];
  if (input.currentVersion) {
    args.push("--current-version", input.currentVersion);
  }
  return args;
}

async function runUpdaterJson(
  config: UpdaterConfig & { scriptPath: string },
  runner: LocalUpdaterRunner,
  args: string[]
): Promise<Record<string, unknown>> {
  const result = await runner(process.execPath, [config.scriptPath, ...args], {
    timeoutMs: config.timeoutMs,
  });
  const stdout = redactSensitiveText(result.stdout);
  const stderr = redactSensitiveText(result.stderr);
  if (result.status !== 0) {
    throw new OperationError(
      "upstream_error",
      `local-updater failed: ${stderr || stdout || `exit ${result.status}`}`,
      { status: result.status, signal: result.signal, stdout, stderr },
      502
    );
  }

  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (!isRecord(parsed)) {
      throw new Error("local-updater JSON output must be an object");
    }
    return redactUnknownValue(parsed) as Record<string, unknown>;
  } catch (error) {
    throw new OperationError(
      "upstream_error",
      "local-updater returned invalid JSON",
      {
        stdout,
        stderr,
        cause: error instanceof Error ? error.message : String(error),
      },
      502
    );
  }
}

function normalizeStatusOutput(
  output: Record<string, unknown>,
  config: UpdaterConfig
): UpdateStatusOutput {
  const summary = buildStatusSummary(config);
  const files = isRecord(output.files) ? output.files : summary.files;
  const status: UpdateStatusOutput = {
    ...summary,
    ...output,
    installRoot:
      typeof output.installRoot === "string"
        ? output.installRoot
        : summary.installRoot,
    dryRun: typeof output.dryRun === "boolean" ? output.dryRun : true,
    files: {
      currentVersion: normalizeTextFile(
        files.currentVersion,
        summary.files.currentVersion
      ),
      rootManifest: normalizeManifest(
        files.rootManifest,
        summary.files.rootManifest
      ),
      currentManifest: normalizeManifest(
        files.currentManifest,
        summary.files.currentManifest
      ),
    },
  };
  status.lastKnownCurrentVersion =
    status.files.currentVersion.value ?? status.files.currentManifest.version;
  return status;
}

function normalizeCheckOutput(
  output: Record<string, unknown>,
  config: UpdaterConfig
): UpdateCheckOutput {
  return {
    ...output,
    command: "check",
    dryRun: readBooleanField(output, "dryRun", true),
    manifest: readStringField(output, "manifest"),
    platform: readStringField(output, "platform"),
    ok: readBooleanField(output, "ok", false),
    current_version: readNullableStringField(output, "current_version"),
    available_version: readStringField(output, "available_version"),
    minimum_supported_version: readStringField(
      output,
      "minimum_supported_version"
    ),
    decision: readStringField(output, "decision"),
    reason: readStringField(output, "reason"),
    artifact_url: readStringField(output, "artifact_url"),
    artifact_sha256: readStringField(output, "artifact_sha256"),
    enabled: config.enabled,
    configured: config.configured,
    disabledReason: config.disabledReason,
  };
}

function buildStatusSummary(config: UpdaterConfig): UpdateStatusOutput {
  const installRoot = config.installRoot ?? "";
  return {
    installRoot,
    dryRun: true,
    files: {
      currentVersion: {
        path: installRoot ? path.join(installRoot, "current-version") : "",
        exists: false,
      },
      rootManifest: {
        path: installRoot ? path.join(installRoot, "manifest.json") : "",
        exists: false,
      },
      currentManifest: {
        path: installRoot
          ? path.join(installRoot, "current", "manifest.json")
          : "",
        exists: false,
      },
    },
    enabled: config.enabled,
    configured: config.configured,
    scriptPathConfigured: Boolean(config.scriptPath),
    installRootConfigured: Boolean(config.installRoot),
    envFileConfigured: Boolean(config.envFile),
    disabledReason: config.disabledReason,
  };
}

function buildDisabledCheckOutput(input: {
  config: UpdaterConfig;
  manifestPath?: string;
  platform: string;
  currentVersion?: string;
  reason?: string;
}): UpdateCheckOutput {
  const reason = input.reason ?? "Updater is not fully configured";
  return {
    command: "check",
    dryRun: true,
    manifest: input.manifestPath ?? "",
    platform: input.platform,
    ok: false,
    current_version: input.currentVersion ?? null,
    available_version: "",
    minimum_supported_version: "",
    decision: "disabled",
    reason,
    artifact_url: "",
    artifact_sha256: "",
    enabled: input.config.enabled,
    configured: input.config.configured,
    disabledReason: reason,
  };
}

function normalizeTextFile(
  value: unknown,
  fallback: StatusFileSummary
): StatusFileSummary {
  if (!isRecord(value)) return fallback;
  return {
    path: typeof value.path === "string" ? value.path : fallback.path,
    exists: typeof value.exists === "boolean" ? value.exists : fallback.exists,
    value: typeof value.value === "string" ? value.value : fallback.value,
  };
}

function normalizeManifest(
  value: unknown,
  fallback: ManifestSummary
): ManifestSummary {
  if (!isRecord(value)) return fallback;
  return {
    path: typeof value.path === "string" ? value.path : fallback.path,
    exists: typeof value.exists === "boolean" ? value.exists : fallback.exists,
    version:
      typeof value.version === "string" ? value.version : fallback.version,
    platform:
      typeof value.platform === "string" ? value.platform : fallback.platform,
  };
}

function trimToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function requireNonEmpty(value: string | undefined, field: string): string {
  const trimmed = trimToUndefined(value);
  if (!trimmed) {
    throw new OperationError("validation_error", `${field} is required`);
  }
  return trimmed;
}

function readStringField(
  record: Record<string, unknown>,
  field: string
): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new OperationError(
      "upstream_error",
      `local-updater output field ${field} must be a string`
    );
  }
  return value;
}

function readNullableStringField(
  record: Record<string, unknown>,
  field: string
): string | null {
  const value = record[field];
  if (value === null) return null;
  if (typeof value === "string") return value;
  throw new OperationError(
    "upstream_error",
    `local-updater output field ${field} must be a string or null`
  );
}

function readBooleanField(
  record: Record<string, unknown>,
  field: string,
  fallback: boolean
): boolean {
  const value = record[field];
  return typeof value === "boolean" ? value : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactUnknownValue(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value))
    return value.map((item) => redactUnknownValue(item));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      redactUnknownValue(entry),
    ])
  );
}

function redactSensitiveText(value: unknown): string {
  let text = String(value);
  for (const name of sensitiveEnvNames) {
    text = text.replace(
      new RegExp(`(${name}\\s*=\\s*)([^\\s\\r\\n'"]+)`, "gi"),
      "$1[REDACTED]"
    );
    text = text.replace(
      new RegExp(`("${name}"\\s*:\\s*")([^"]*)(")`, "gi"),
      "$1[REDACTED]$3"
    );
  }
  return text
    .replace(/postgres(?:ql)?:\/\/[^\s'",]+/gi, "postgresql://[REDACTED]")
    .replace(/(Authorization\s*[:=]\s*)(Bearer\s+)?[^\s'",]+/gi, "$1[REDACTED]")
    .replace(/(Cookie\s*[:=]\s*)[^\r\n"]+/gi, "$1[REDACTED]");
}
