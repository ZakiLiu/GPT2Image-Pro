/**
 * Admin updater wrapper tests
 *
 * 职责：验证 Web 侧 updater wrapper 的默认关闭、固定 argv、无 shell 边界、
 * 输出脱敏、JSON 解析和 confirmVersion 显式确认门。
 * 使用方：M1-P5 在线更新入口质量门，保持 DB-free 且不启动真实子进程。
 * 关键依赖：Vitest、createUpdaterAdminService 的 fake runner 注入。
 */

import { OperationError } from "@repo/shared/uol";
import { describe, expect, it } from "vitest";

import {
  createUpdaterAdminService,
  type LocalUpdaterRunner,
  type LocalUpdaterRunnerResult,
} from "./updater-admin";

interface RunnerCall {
  command: string;
  args: string[];
  timeoutMs: number;
}

const baseEnv = {
  UPDATER_ENABLED: "1",
  UPDATER_SCRIPT_PATH: "/opt/gpt2image/current/scripts/local-updater.mjs",
  UPDATER_INSTALL_ROOT: "/opt/gpt2image",
  UPDATER_ENV_FILE: "/etc/gpt2image/gpt2image.env",
  UPDATER_MANIFEST_PATH: "/opt/gpt2image/manifest.json",
};

function okJson(value: unknown): LocalUpdaterRunnerResult {
  return {
    status: 0,
    signal: null,
    stdout: `${JSON.stringify(value)}\n`,
    stderr: "",
  };
}

function makeRunner(
  handler: (call: RunnerCall, index: number) => LocalUpdaterRunnerResult
): { calls: RunnerCall[]; runner: LocalUpdaterRunner } {
  const calls: RunnerCall[] = [];
  return {
    calls,
    runner: async (command, args, options) => {
      const call = { command, args, timeoutMs: options.timeoutMs };
      calls.push(call);
      return handler(call, calls.length - 1);
    },
  };
}

function makeCheckOutput(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    command: "check",
    dryRun: true,
    manifest: "/opt/gpt2image/manifest.json",
    platform: "linux-x64",
    ok: true,
    current_version: "v0.5.6",
    available_version: "v0.5.7-beta.1",
    minimum_supported_version: "v0.5.6",
    decision: "upgrade",
    reason: "available version is newer than current version",
    artifact_url:
      "https://downloads.example.invalid/gpt2image-pro/v0.5.7-beta.1.tar.gz",
    artifact_sha256: "a".repeat(64),
    ...overrides,
  };
}

describe("createUpdaterAdminService", () => {
  it("默认关闭时 status/check 返回配置摘要，apply 被拒绝且不启动子进程", async () => {
    const { calls, runner } = makeRunner(() => okJson({}));
    const service = createUpdaterAdminService({ env: {}, runner });

    await expect(service.getUpdaterStatus()).resolves.toMatchObject({
      enabled: false,
      configured: false,
      disabledReason: "UPDATER_ENABLED is not truthy",
    });
    await expect(service.checkUpdater()).resolves.toMatchObject({
      command: "check",
      ok: false,
      decision: "disabled",
      disabledReason: "UPDATER_ENABLED is not truthy",
    });
    await expect(
      service.applyUpdater({
        manifestPath: "/tmp/manifest.json",
        artifactPath: "/tmp/release.tar.gz",
        runId: "run-1",
        confirmVersion: "v0.5.7-beta.1",
      })
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(calls).toHaveLength(0);
  });

  it("开启但缺少 script path 时拒绝 apply", async () => {
    const { calls, runner } = makeRunner(() => okJson({}));
    const service = createUpdaterAdminService({
      env: {
        UPDATER_ENABLED: "true",
        UPDATER_INSTALL_ROOT: "/opt/gpt2image",
        UPDATER_ENV_FILE: "/etc/gpt2image/gpt2image.env",
      },
      runner,
    });

    await expect(
      service.applyUpdater({
        manifestPath: "/tmp/manifest.json",
        artifactPath: "/tmp/release.tar.gz",
        runId: "run-1",
        confirmVersion: "v0.5.7-beta.1",
      })
    ).rejects.toMatchObject({
      code: "validation_error",
      message: "UPDATER_SCRIPT_PATH is required",
    });
    expect(calls).toHaveLength(0);
  });

  it("开启但缺少 install root 或 env file 时拒绝 apply", async () => {
    const { calls, runner } = makeRunner(() => okJson({}));
    const service = createUpdaterAdminService({
      env: {
        UPDATER_ENABLED: "true",
        UPDATER_SCRIPT_PATH: "/opt/gpt2image/current/scripts/local-updater.mjs",
      },
      runner,
    });

    await expect(
      service.applyUpdater({
        manifestPath: "/tmp/manifest.json",
        artifactPath: "/tmp/release.tar.gz",
        runId: "run-1",
        confirmVersion: "v0.5.7-beta.1",
      })
    ).rejects.toMatchObject({
      code: "validation_error",
      message: "UPDATER_INSTALL_ROOT is required",
    });
    expect(calls).toHaveLength(0);
  });

  it("check 使用服务端配置组装固定 argv", async () => {
    const { calls, runner } = makeRunner(() => okJson(makeCheckOutput()));
    const service = createUpdaterAdminService({ env: baseEnv, runner });

    const output = await service.checkUpdater({
      manifestPath: "/tmp/manifest.json",
      currentVersion: "v0.5.6",
    });

    expect(output.available_version).toBe("v0.5.7-beta.1");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: process.execPath });
    expect(calls[0]?.args).toEqual([
      "/opt/gpt2image/current/scripts/local-updater.mjs",
      "check",
      "--manifest",
      "/tmp/manifest.json",
      "--platform",
      "linux-x64",
      "--install-root",
      "/opt/gpt2image",
      "--current-version",
      "v0.5.6",
    ]);
  });

  it("拒绝请求体覆盖 installRoot 或 envFile", async () => {
    const { calls, runner } = makeRunner(() => okJson(makeCheckOutput()));
    const service = createUpdaterAdminService({ env: baseEnv, runner });

    await expect(
      service.checkUpdater({ installRoot: "/tmp/evil" })
    ).rejects.toMatchObject({ code: "validation_error" });
    await expect(
      service.applyUpdater({
        manifestPath: "/tmp/manifest.json",
        artifactPath: "/tmp/release.tar.gz",
        runId: "run-1",
        confirmVersion: "v0.5.7-beta.1",
        envFile: "/tmp/evil.env",
      })
    ).rejects.toMatchObject({ code: "validation_error" });
    expect(calls).toHaveLength(0);
  });

  it("非零退出会脱敏 stdout/stderr 后作为 upstream_error 返回", async () => {
    const { runner } = makeRunner(() => ({
      status: 1,
      signal: null,
      stdout: "DATABASE_URL=postgresql://user:db-pass@localhost/app",
      stderr: "Authorization: Bearer bearer-token",
    }));
    const service = createUpdaterAdminService({ env: baseEnv, runner });

    await expect(
      service.checkUpdater({ manifestPath: "/tmp/manifest.json" })
    ).rejects.toMatchObject({ code: "upstream_error" });
    try {
      await service.checkUpdater({ manifestPath: "/tmp/manifest.json" });
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(OperationError);
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain("db-pass");
      expect(message).not.toContain("bearer-token");
      expect(message).toContain("[REDACTED]");
    }
  });

  it("invalid JSON 被映射为 upstream_error", async () => {
    const { runner } = makeRunner(() => ({
      status: 0,
      signal: null,
      stdout: "not-json",
      stderr: "",
    }));
    const service = createUpdaterAdminService({ env: baseEnv, runner });

    await expect(
      service.checkUpdater({ manifestPath: "/tmp/manifest.json" })
    ).rejects.toMatchObject({
      code: "upstream_error",
      message: "local-updater returned invalid JSON",
    });
  });

  it("apply 先校验 confirmVersion，再用服务端 env file 和 install root 组装 argv", async () => {
    const { calls, runner } = makeRunner((_call, index) => {
      if (index === 0) return okJson(makeCheckOutput());
      return okJson({
        command: "apply",
        ok: true,
        status: "completed",
        version: "v0.5.7-beta.1",
      });
    });
    const service = createUpdaterAdminService({ env: baseEnv, runner });

    await expect(
      service.applyUpdater({
        manifestPath: "/tmp/manifest.json",
        artifactPath: "/tmp/release.tar.gz",
        runId: "run-1",
        confirmVersion: "v0.5.7-beta.1",
      })
    ).resolves.toMatchObject({
      command: "apply",
      ok: true,
      runId: "run-1",
      version: "v0.5.7-beta.1",
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args).toEqual([
      "/opt/gpt2image/current/scripts/local-updater.mjs",
      "apply",
      "--install-root",
      "/opt/gpt2image",
      "--manifest",
      "/tmp/manifest.json",
      "--env-file",
      "/etc/gpt2image/gpt2image.env",
      "--artifact-file",
      "/tmp/release.tar.gz",
      "--run-id",
      "run-1",
      "--platform",
      "linux-x64",
    ]);
  });

  it("apply 的 confirmVersion 与 manifest 版本不一致时不执行 apply", async () => {
    const { calls, runner } = makeRunner(() => okJson(makeCheckOutput()));
    const service = createUpdaterAdminService({ env: baseEnv, runner });

    await expect(
      service.applyUpdater({
        manifestPath: "/tmp/manifest.json",
        artifactPath: "/tmp/release.tar.gz",
        runId: "run-1",
        confirmVersion: "v0.5.6",
      })
    ).rejects.toMatchObject({ code: "validation_error" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args[1]).toBe("check");
  });
});
