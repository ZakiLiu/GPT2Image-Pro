/**
 * UOL update operations tests
 *
 * 职责：验证 update.check、update.status、update.apply 的注册元数据、
 * 权限与幂等输入校验。使用方为 shared 包 Vitest，覆盖 M1-P5 UOL-first 门禁。
 * 关键依赖：../operations/update 的副作用注册、invokeOperation 的统一网关。
 */
import { describe, expect, it } from "vitest";

import "../operations/update";

import { OperationError } from "../errors";
import { invokeOperation } from "../invoke";
import type { Principal } from "../principal";
import { getOperation } from "../registry";

const adminPrincipal: Principal = {
  type: "user",
  userId: "admin-1",
  role: "admin",
};

const userPrincipal: Principal = {
  type: "user",
  userId: "user-1",
  role: "user",
};

describe("UOL update operations", () => {
  it("registers update.status metadata", () => {
    const op = getOperation("update.status");

    expect(op).toBeDefined();
    expect(op?.domain).toBe("update");
    expect(op?.access).toEqual({ kind: "admin" });
    expect(op?.readOnly).toBe(true);
    expect(op?.destructive).toBe(false);
    expect(op?.idempotency).toEqual({ kind: "natural" });
    expect(op?.sideEffects).toEqual([]);
    expect(op?.processLocalState).toBe(true);
  });

  it("registers update.check metadata", () => {
    const op = getOperation("update.check");

    expect(op).toBeDefined();
    expect(op?.domain).toBe("update");
    expect(op?.access).toEqual({ kind: "admin" });
    expect(op?.readOnly).toBe(true);
    expect(op?.destructive).toBe(false);
    expect(op?.idempotency).toEqual({ kind: "natural" });
    expect(op?.sideEffects).toEqual(["external-call"]);
    expect(op?.processLocalState).toBe(true);
  });

  it("registers update.apply as destructive and runId-idempotent", () => {
    const op = getOperation("update.apply");

    expect(op).toBeDefined();
    expect(op?.domain).toBe("update");
    expect(op?.access).toEqual({ kind: "admin" });
    expect(op?.readOnly).toBe(false);
    expect(op?.destructive).toBe(true);
    expect(op?.idempotency).toEqual({
      kind: "required",
      keyField: "runId",
      scope: "global",
    });
    expect(op?.sideEffects).toEqual(["external-call", "audit"]);
    expect(op?.processLocalState).toBe(true);
  });

  it("rejects update.apply without runId through invoke validation", async () => {
    try {
      await invokeOperation(
        "update.apply",
        {
          manifestPath: "/opt/gpt2image/manifest.json",
          artifactPath: "/opt/gpt2image/downloads/release.tar.gz",
          confirmVersion: "v1.2.3",
        },
        adminPrincipal
      );
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).code).toBe("validation_error");
    }
  });

  it("rejects server path overrides through strict input validation", async () => {
    await expect(
      invokeOperation(
        "update.status",
        { installRoot: "/tmp/evil" },
        adminPrincipal
      )
    ).rejects.toMatchObject({ code: "validation_error" });

    await expect(
      invokeOperation(
        "update.check",
        {
          manifestPath: "/opt/gpt2image/manifest.json",
          installRoot: "/tmp/evil",
        },
        adminPrincipal
      )
    ).rejects.toMatchObject({ code: "validation_error" });

    await expect(
      invokeOperation(
        "update.apply",
        {
          manifestPath: "/opt/gpt2image/manifest.json",
          artifactPath: "/opt/gpt2image/downloads/release.tar.gz",
          runId: "run-1",
          confirmVersion: "v1.2.3",
          envFile: "/tmp/evil.env",
        },
        adminPrincipal
      )
    ).rejects.toMatchObject({ code: "validation_error" });
  });

  it("rejects normal users from update.status before execute binding", async () => {
    try {
      await invokeOperation("update.status", {}, userPrincipal);
      expect.fail("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(OperationError);
      expect((error as OperationError).code).toBe("forbidden");
    }
  });
});
