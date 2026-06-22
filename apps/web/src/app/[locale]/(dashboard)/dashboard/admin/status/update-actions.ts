"use server";

/**
 * Admin update server actions。
 *
 * 职责：作为后台状态页的 thin transport，只做 adminAction 鉴权、UOL 初始化、
 * Principal 构造和 invokeOperation 调用。真实本地 updater 执行逻辑由 UOL 绑定层
 * 统一承接，避免在页面传输层直接接触进程执行、脚本路径或服务端环境文件。
 * 使用方：apps/web admin status 页面中的 UpdateStatusCard 客户端组件。
 * 关键依赖：next-safe-action、shared UOL gateway、apps/web UOL lazy init。
 */
import { normalizeUserRole } from "@repo/shared/auth/roles";
import { ActionUserError, adminAction } from "@repo/shared/safe-action";
import {
  invokeOperation,
  OperationError,
  type Principal,
} from "@repo/shared/uol";
import { z } from "zod";

import { ensureUolInitialized } from "@/server/uol-init";

const optionalNonEmptyStringSchema = z.string().trim().min(1).optional();

const emptyInputSchema = z.object({}).optional();

const updateCheckActionSchema = z.object({
  manifestPath: optionalNonEmptyStringSchema,
  currentVersion: optionalNonEmptyStringSchema,
  platform: optionalNonEmptyStringSchema,
});

const updateApplyActionSchema = z.object({
  manifestPath: z.string().trim().min(1),
  artifactPath: z.string().trim().min(1),
  runId: z.string().trim().min(1),
  confirmVersion: z.string().trim().min(1),
  platform: optionalNonEmptyStringSchema,
});

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

export interface AdminUpdateStatusOutput {
  installRoot: string;
  dryRun: boolean;
  files: {
    currentVersion: StatusFileSummary;
    rootManifest: ManifestSummary;
    currentManifest: ManifestSummary;
  };
  enabled?: boolean;
  configured?: boolean;
  scriptPathConfigured?: boolean;
  installRootConfigured?: boolean;
  envFileConfigured?: boolean;
  disabledReason?: string;
  lastKnownCurrentVersion?: string;
  [key: string]: unknown;
}

export interface AdminUpdateCheckOutput {
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
  enabled?: boolean;
  configured?: boolean;
  disabledReason?: string;
  [key: string]: unknown;
}

export interface AdminUpdateApplyOutput {
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
 * 将 adminAction ctx 归一化为 UOL Principal。
 *
 * @param ctx - adminAction 注入的用户上下文。
 * @returns UOL 用户 Principal，role 会收窄到 AppUserRole。
 */
function createAdminPrincipal(ctx: {
  userId: string;
  role?: string | null;
}): Principal {
  return {
    type: "user",
    userId: ctx.userId,
    role: normalizeUserRole(ctx.role),
  };
}

/**
 * 把 UOL 的可预期错误转成 next-safe-action 会透传给 UI 的用户错误。
 *
 * @param error - invokeOperation 抛出的未知错误。
 * @throws ActionUserError 或原始未知错误。
 */
function throwActionUserError(error: unknown): never {
  if (error instanceof OperationError) {
    throw new ActionUserError(error.message);
  }
  throw error;
}

/**
 * 初始化 UOL 并调用指定 update operation。
 *
 * @param name - UOL operation 名称。
 * @param input - 已由 action schema 校验的输入。
 * @param ctx - adminAction 注入上下文。
 * @returns operation 输出。
 */
async function invokeAdminUpdateOperation<TOutput>(
  name: "update.status" | "update.check" | "update.apply",
  input: unknown,
  ctx: { userId: string; role?: string | null },
): Promise<TOutput> {
  await ensureUolInitialized();
  try {
    return await invokeOperation<TOutput>(
      name,
      input,
      createAdminPrincipal(ctx),
    );
  } catch (error) {
    throwActionUserError(error);
  }
}

export const getAdminUpdateStatusAction = adminAction
  .metadata({ action: "adminUpdate.status" })
  .schema(emptyInputSchema)
  .action(async ({ parsedInput, ctx }) => {
    return await invokeAdminUpdateOperation<AdminUpdateStatusOutput>(
      "update.status",
      parsedInput ?? {},
      ctx,
    );
  });

export const checkAdminUpdateAction = adminAction
  .metadata({ action: "adminUpdate.check" })
  .schema(updateCheckActionSchema)
  .action(async ({ parsedInput, ctx }) => {
    return await invokeAdminUpdateOperation<AdminUpdateCheckOutput>(
      "update.check",
      parsedInput,
      ctx,
    );
  });

export const applyAdminUpdateAction = adminAction
  .metadata({ action: "adminUpdate.apply" })
  .schema(updateApplyActionSchema)
  .action(async ({ parsedInput, ctx }) => {
    return await invokeAdminUpdateOperation<AdminUpdateApplyOutput>(
      "update.apply",
      parsedInput,
      ctx,
    );
  });
