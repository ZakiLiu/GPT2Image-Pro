/**
 * UOL Operations - update 领域
 *
 * 职责：注册 binary-style 在线更新相关操作（检查更新、读取状态、执行更新）。
 * 使用方：operations/index.ts 副作用导入触发注册；后续 apps/web/src/server/uol-bindings.ts
 * 绑定真实本地 updater wrapper。当前 shared 层只声明 schema、权限、幂等与副作用。
 * 关键依赖：../registry（defineOperation）、zod（输入/输出 schema 校验）。
 */
import { z } from "zod";

import { defineOperation } from "../registry";

/** 只允许非空路径或 URL 字符串，具体白名单和路径边界由 app 层 wrapper 校验。 */
const nonEmptyStringSchema = z.string().min(1);

/** 本地 updater 返回的可选文本文件摘要。 */
const optionalTextFileSchema = z
  .object({
    path: z.string(),
    exists: z.boolean(),
    value: z.string().optional(),
  })
  .passthrough();

/** 本地 updater 返回的 manifest 非敏感摘要。 */
const optionalManifestSummarySchema = z
  .object({
    path: z.string(),
    exists: z.boolean(),
    version: z.string().optional(),
    platform: z.string().optional(),
  })
  .passthrough();

/** update.status 的输入 schema：安装根只能由服务端环境变量配置。 */
export const updateStatusInputSchema = z.object({}).strict();

/** update.status 的输出 schema：对应 local-updater status 的只读安装状态摘要。 */
export const updateStatusSchema = z
  .object({
    installRoot: z.string(),
    dryRun: z.boolean(),
    files: z.object({
      currentVersion: optionalTextFileSchema,
      rootManifest: optionalManifestSummarySchema,
      currentManifest: optionalManifestSummarySchema,
    }),
  })
  .passthrough();

/** update.check 的输入 schema：manifest 可来自配置或显式传入，安装根不得由请求覆盖。 */
export const updateCheckInputSchema = z
  .object({
    manifestPath: nonEmptyStringSchema.optional(),
    currentVersion: nonEmptyStringSchema.optional(),
    platform: nonEmptyStringSchema.optional(),
  })
  .strict();

/** update.check 的输出 schema：对应 local-updater check 的非敏感摘要。 */
export const updateCheckOutputSchema = z
  .object({
    command: z.literal("check"),
    dryRun: z.boolean(),
    manifest: z.string(),
    platform: z.string(),
    ok: z.boolean(),
    current_version: z.string().nullable(),
    available_version: z.string(),
    minimum_supported_version: z.string(),
    decision: z.string(),
    reason: z.string(),
    artifact_url: z.string(),
    artifact_sha256: z.string(),
  })
  .passthrough();

/** update.apply 的输入 schema：runId 是全局幂等键，confirmVersion 是显式确认门。 */
export const updateApplyInputSchema = z
  .object({
    manifestPath: nonEmptyStringSchema,
    artifactPath: nonEmptyStringSchema,
    runId: nonEmptyStringSchema,
    confirmVersion: nonEmptyStringSchema,
    platform: nonEmptyStringSchema.optional(),
  })
  .strict();

/** update.apply 的输出 schema：真实字段由本地 updater apply/update wrapper 透传非敏感摘要。 */
export const updateApplyOutputSchema = z
  .object({
    command: z.enum(["apply", "update"]).optional(),
    ok: z.boolean().optional(),
    runId: z.string().optional(),
    status: z.string().optional(),
    version: z.string().optional(),
    apply_json: z.string().optional(),
    rollback_status: z.string().optional(),
    healthcheck_status: z.string().optional(),
  })
  .passthrough();

/**
 * update.status - 读取本机安装状态。
 *
 * 纯读操作，只依赖进程所在主机的安装根与 current/manifest 文件状态。
 * 真实读取由 app 层绑定，shared 层保持 stub 防止未绑定时绕过 UOL。
 */
export const updateStatus = defineOperation({
  name: "update.status",
  domain: "update",
  title: "Read Update Status",
  description:
    "读取 binary-style 安装根的当前版本、manifest 与 current 状态，仅管理员可调用。",
  input: updateStatusInputSchema,
  output: updateStatusSchema,
  access: { kind: "admin" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: [],
  processLocalState: true,
  execute: async () => {
    throw new Error("Not yet wired: update.status");
  },
});

/**
 * update.check - 检查可用更新。
 *
 * 只读但会访问 release manifest，因此声明 external-call；真实网络/文件访问由
 * app 层 wrapper 统一做默认关闭、命令白名单和日志脱敏。
 */
export const updateCheck = defineOperation({
  name: "update.check",
  domain: "update",
  title: "Check For Update",
  description:
    "读取 release manifest 并比较当前版本，返回是否可升级的非敏感摘要。",
  input: updateCheckInputSchema,
  output: updateCheckOutputSchema,
  access: { kind: "admin" },
  readOnly: true,
  destructive: false,
  idempotency: { kind: "natural" },
  sideEffects: ["external-call"],
  processLocalState: true,
  execute: async () => {
    throw new Error("Not yet wired: update.check");
  },
});

/**
 * update.apply - 执行在线更新。
 *
 * 破坏性操作：会安装 release、运行迁移、切换 current、重启白名单服务并做健康检查。
 * runId 是全局幂等键，confirmVersion 用于 UI/agent 显式确认，未绑定真实 execute 前
 * invokeOperation 会返回 not_implemented，不能绕过 UOL 直接执行。
 */
export const updateApply = defineOperation({
  name: "update.apply",
  domain: "update",
  title: "Apply Update",
  description:
    "执行 binary-style 在线更新，要求 manifestPath、artifactPath、runId 与 confirmVersion。",
  input: updateApplyInputSchema,
  output: updateApplyOutputSchema,
  access: { kind: "admin" },
  readOnly: false,
  destructive: true,
  idempotency: {
    kind: "required",
    keyField: "runId",
    scope: "global",
  },
  sideEffects: ["external-call", "audit"],
  processLocalState: true,
  execute: async () => {
    throw new Error("Not yet wired: update.apply");
  },
});
