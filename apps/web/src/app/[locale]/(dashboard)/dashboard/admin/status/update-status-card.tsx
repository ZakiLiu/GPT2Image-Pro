"use client";

/**
 * Admin updater status card。
 *
 * 职责：在全局状态页展示默认关闭的 binary-style 在线更新入口，调用 thin server
 * actions 读取状态、检查 manifest、执行显式确认后的 apply。组件只展示脱敏摘要，
 * 不接收也不渲染服务端 env 文件内容或 secrets。
 * 使用方：`/dashboard/admin/status` 页面，仅 admin/super_admin 渲染。
 * 关键依赖：next-safe-action、Shadcn/UI、sonner toast。
 */
import { Badge } from "@repo/ui/components/badge";
import { Button } from "@repo/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/ui/components/card";
import { Input } from "@repo/ui/components/input";
import { Label } from "@repo/ui/components/label";
import { Separator } from "@repo/ui/components/separator";
import { RefreshCw, Rocket, Search, ShieldAlert } from "lucide-react";
import { useAction } from "next-safe-action/hooks";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { useRouter } from "@/i18n/routing";
import {
  applyAdminUpdateAction,
  checkAdminUpdateAction,
  getAdminUpdateStatusAction,
  type AdminUpdateApplyOutput,
  type AdminUpdateCheckOutput,
  type AdminUpdateStatusOutput,
} from "./update-actions";

interface UpdateStatusCardProps {
  locale: string;
  canApply: boolean;
}

interface CheckFormState {
  manifestPath: string;
  currentVersion: string;
  platform: string;
}

interface ApplyFormState {
  manifestPath: string;
  artifactPath: string;
  runId: string;
  confirmVersion: string;
  platform: string;
}

/**
 * 按当前 locale 返回英中文案。
 *
 * @param locale - 当前页面 locale。
 * @param en - 英文文案。
 * @param zh - 中文文案。
 * @returns 匹配 locale 的文案。
 */
function copy(locale: string, en: string, zh: string) {
  return locale === "zh" ? zh : en;
}

/**
 * 把空白输入收敛为 undefined，避免把空字符串传给 UOL schema。
 *
 * @param value - 表单原始字符串。
 * @returns trim 后的非空字符串或 undefined。
 */
function optionalField(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * 格式化可选状态字段，避免 UI 显示空白。
 *
 * @param value - 可能为空的字符串。
 * @param fallback - 空值回退文案。
 * @returns 可展示文本。
 */
function formatOptionalText(value: string | null | undefined, fallback: string) {
  return value?.trim() ? value : fallback;
}

/**
 * 根据布尔状态选择 Badge 样式。
 *
 * @param active - 是否启用或配置完成。
 * @returns Badge variant。
 */
function booleanBadgeVariant(active: boolean | undefined) {
  return active ? "default" : "secondary";
}

/**
 * 从 check 表单构造 update.check 输入。
 *
 * @param form - 当前 check 表单状态。
 * @returns 去掉空白字段后的 action 输入。
 */
function buildCheckInput(form: CheckFormState) {
  return {
    ...(optionalField(form.manifestPath)
      ? { manifestPath: optionalField(form.manifestPath) }
      : {}),
    ...(optionalField(form.currentVersion)
      ? { currentVersion: optionalField(form.currentVersion) }
      : {}),
    ...(optionalField(form.platform) ? { platform: optionalField(form.platform) } : {}),
  };
}

/**
 * 从 apply 表单构造 update.apply 输入。
 *
 * @param form - 当前 apply 表单状态。
 * @returns action 输入，必填字段由服务端 schema 再兜底校验。
 */
function buildApplyInput(form: ApplyFormState) {
  return {
    manifestPath: form.manifestPath.trim(),
    artifactPath: form.artifactPath.trim(),
    runId: form.runId.trim(),
    confirmVersion: form.confirmVersion.trim(),
    ...(optionalField(form.platform) ? { platform: optionalField(form.platform) } : {}),
  };
}

/**
 * 生成默认 runId，便于管理员按一次检查后直接填充 apply 表单。
 *
 * @returns 带时间戳的幂等键。
 */
function createDefaultRunId() {
  return `admin-update-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

/**
 * 展示单个配置/结果字段。
 *
 * @param props.label - 字段名。
 * @param props.value - 字段值。
 * @returns 小型只读字段块。
 */
function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1 rounded-md border bg-muted/20 p-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="break-words text-sm">{value}</div>
    </div>
  );
}

/**
 * 在线更新管理卡片。
 *
 * @param props.locale - 当前 locale。
 * @param props.canApply - 当前用户是否允许看到 destructive apply 控件。
 * @returns 后台更新状态、检查和执行 UI。
 */
export function UpdateStatusCard({ locale, canApply }: UpdateStatusCardProps) {
  const router = useRouter();
  const [checkForm, setCheckForm] = useState<CheckFormState>({
    manifestPath: "",
    currentVersion: "",
    platform: "linux-x64",
  });
  const [applyForm, setApplyForm] = useState<ApplyFormState>({
    manifestPath: "",
    artifactPath: "",
    runId: createDefaultRunId(),
    confirmVersion: "",
    platform: "linux-x64",
  });
  const [confirmation, setConfirmation] = useState("");

  const {
    execute: loadStatus,
    result: statusResult,
    isPending: isLoadingStatus,
  } = useAction(getAdminUpdateStatusAction, {
    onError: ({ error }) => {
      toast.error(
        error.serverError || copy(locale, "Failed to load updater status", "加载更新状态失败"),
      );
    },
  });

  const {
    execute: runCheck,
    result: checkResult,
    isPending: isChecking,
  } = useAction(checkAdminUpdateAction, {
    onSuccess: ({ data }) => {
      if (!data) return;
      setApplyForm((current) => ({
        ...current,
        manifestPath: current.manifestPath || data.manifest,
        confirmVersion: current.confirmVersion || data.available_version,
        platform: current.platform || data.platform,
      }));
      toast.success(copy(locale, "Update check finished", "更新检查完成"));
    },
    onError: ({ error }) => {
      toast.error(
        error.serverError || copy(locale, "Update check failed", "更新检查失败"),
      );
    },
  });

  const {
    execute: runApply,
    result: applyResult,
    isPending: isApplying,
  } = useAction(applyAdminUpdateAction, {
    onSuccess: ({ data }) => {
      if (data?.status || data?.version) {
        toast.success(copy(locale, "Update apply finished", "更新执行完成"));
      } else {
        toast.success(copy(locale, "Update apply submitted", "更新执行已提交"));
      }
      setConfirmation("");
      loadStatus({});
      router.refresh();
    },
    onError: ({ error }) => {
      toast.error(
        error.serverError || copy(locale, "Update apply failed", "更新执行失败"),
      );
    },
  });

  useEffect(() => {
    loadStatus({});
  }, [loadStatus]);

  const status = statusResult.data as AdminUpdateStatusOutput | undefined;
  const check = checkResult.data as AdminUpdateCheckOutput | undefined;
  const apply = applyResult.data as AdminUpdateApplyOutput | undefined;
  const expectedConfirmation = applyForm.confirmVersion.trim();
  const canSubmitApply =
    canApply &&
    Boolean(applyForm.manifestPath.trim()) &&
    Boolean(applyForm.artifactPath.trim()) &&
    Boolean(applyForm.runId.trim()) &&
    Boolean(expectedConfirmation) &&
    confirmation.trim() === expectedConfirmation;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2">
              <Rocket className="h-5 w-5" />
              {copy(locale, "Online Update", "在线更新")}
            </CardTitle>
            <CardDescription>
              {copy(
                locale,
                "Default-off Admin Operation entry for binary-style releases. Docker Compose remains the recommended path for new deployments.",
                "默认关闭的 binary-style Admin Operation 入口。新部署仍推荐使用 Docker Compose。",
              )}
            </CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isLoadingStatus}
            onClick={() => loadStatus({})}
          >
            <RefreshCw className={isLoadingStatus ? "animate-spin" : ""} />
            {copy(locale, "Reload", "重新加载")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-3 md:grid-cols-3">
          <SummaryItem
            label={copy(locale, "Updater enabled", "更新器启用")}
            value={status?.enabled ? "true" : "false"}
          />
          <SummaryItem
            label={copy(locale, "Updater configured", "更新器配置完成")}
            value={status?.configured ? "true" : "false"}
          />
          <SummaryItem
            label={copy(locale, "Current version", "当前版本")}
            value={formatOptionalText(
              status?.lastKnownCurrentVersion ?? status?.files.currentVersion.value,
              copy(locale, "Unknown", "未知"),
            )}
          />
        </div>

        <div className="flex flex-wrap gap-2">
          <Badge variant={booleanBadgeVariant(status?.enabled)}>
            {status?.enabled
              ? copy(locale, "Enabled", "已启用")
              : copy(locale, "Disabled", "已禁用")}
          </Badge>
          <Badge variant={booleanBadgeVariant(status?.configured)}>
            {status?.configured
              ? copy(locale, "Configured", "已配置")
              : copy(locale, "Not configured", "未配置")}
          </Badge>
          {status?.disabledReason ? (
            <Badge variant="outline">{status.disabledReason}</Badge>
          ) : null}
        </div>

        <form
          className="space-y-4 rounded-lg border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            runCheck(buildCheckInput(checkForm));
          }}
        >
          <div className="flex items-center gap-2 font-medium">
            <Search className="h-4 w-4" />
            {copy(locale, "Check release manifest", "检查 release manifest")}
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-2 md:col-span-2">
              <Label htmlFor="update-manifest-path">
                {copy(locale, "Manifest path or URL", "Manifest 路径或 URL")}
              </Label>
              <Input
                id="update-manifest-path"
                value={checkForm.manifestPath}
                onChange={(event) =>
                  setCheckForm((current) => ({
                    ...current,
                    manifestPath: event.target.value,
                  }))
                }
                placeholder={copy(
                  locale,
                  "Leave empty to use server default",
                  "留空则使用服务端默认配置",
                )}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="update-platform">
                {copy(locale, "Platform", "平台")}
              </Label>
              <Input
                id="update-platform"
                value={checkForm.platform}
                onChange={(event) =>
                  setCheckForm((current) => ({
                    ...current,
                    platform: event.target.value,
                  }))
                }
              />
            </div>
            <div className="space-y-2 md:col-span-3">
              <Label htmlFor="update-current-version">
                {copy(locale, "Current version override", "当前版本覆盖值")}
              </Label>
              <Input
                id="update-current-version"
                value={checkForm.currentVersion}
                onChange={(event) =>
                  setCheckForm((current) => ({
                    ...current,
                    currentVersion: event.target.value,
                  }))
                }
                placeholder={copy(
                  locale,
                  "Usually empty; updater reads current version from install root",
                  "通常留空；updater 会从安装根读取当前版本",
                )}
              />
            </div>
          </div>
          <Button type="submit" disabled={isChecking}>
            <Search className={isChecking ? "animate-spin" : ""} />
            {isChecking
              ? copy(locale, "Checking", "检查中")
              : copy(locale, "Check update", "检查更新")}
          </Button>
        </form>

        {check ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <SummaryItem
              label={copy(locale, "Available version", "可用版本")}
              value={formatOptionalText(check.available_version, "-")}
            />
            <SummaryItem
              label={copy(locale, "Decision", "决策")}
              value={formatOptionalText(check.decision, "-")}
            />
            <SummaryItem
              label={copy(locale, "Reason", "原因")}
              value={formatOptionalText(check.reason, "-")}
            />
            <SummaryItem
              label={copy(locale, "Artifact SHA256", "制品 SHA256")}
              value={formatOptionalText(check.artifact_sha256, "-")}
            />
          </div>
        ) : null}

        {canApply ? (
          <>
            <Separator />
            <form
              className="space-y-4 rounded-lg border border-destructive/30 bg-destructive/5 p-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (!canSubmitApply) {
                  toast.error(
                    copy(
                      locale,
                      "Type the exact confirmVersion before applying",
                      "执行前必须输入完全一致的 confirmVersion",
                    ),
                  );
                  return;
                }
                runApply(buildApplyInput(applyForm));
              }}
            >
              <div className="flex items-start gap-2 text-sm">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <div className="space-y-1">
                  <div className="font-medium">
                    {copy(locale, "Destructive apply confirmation", "破坏性更新确认")}
                  </div>
                  <p className="text-muted-foreground">
                    {copy(
                      locale,
                      "Apply switches the local current release and may run DB migration steps. DB migration does not automatically rollback; application files can rollback separately.",
                      "执行更新会切换本机 current release，并可能运行 DB migration 步骤。DB migration 不会自动 rollback；应用文件 rollback 是独立边界。",
                    )}
                  </p>
                </div>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="apply-manifest-path">
                    {copy(locale, "Manifest path", "Manifest 路径")}
                  </Label>
                  <Input
                    id="apply-manifest-path"
                    value={applyForm.manifestPath}
                    onChange={(event) =>
                      setApplyForm((current) => ({
                        ...current,
                        manifestPath: event.target.value,
                      }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="apply-artifact-path">
                    {copy(locale, "Artifact file path", "制品文件路径")}
                  </Label>
                  <Input
                    id="apply-artifact-path"
                    value={applyForm.artifactPath}
                    onChange={(event) =>
                      setApplyForm((current) => ({
                        ...current,
                        artifactPath: event.target.value,
                      }))
                    }
                    placeholder={copy(
                      locale,
                      "Server-local bundle path, not a secret",
                      "服务端本地 bundle 路径，不填写密钥",
                    )}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="apply-run-id">runId</Label>
                  <Input
                    id="apply-run-id"
                    value={applyForm.runId}
                    onChange={(event) =>
                      setApplyForm((current) => ({
                        ...current,
                        runId: event.target.value,
                      }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="apply-confirm-version">confirmVersion</Label>
                  <Input
                    id="apply-confirm-version"
                    value={applyForm.confirmVersion}
                    onChange={(event) =>
                      setApplyForm((current) => ({
                        ...current,
                        confirmVersion: event.target.value,
                      }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="apply-platform">
                    {copy(locale, "Platform", "平台")}
                  </Label>
                  <Input
                    id="apply-platform"
                    value={applyForm.platform}
                    onChange={(event) =>
                      setApplyForm((current) => ({
                        ...current,
                        platform: event.target.value,
                      }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="apply-confirmation">
                    {copy(locale, "Type confirmVersion to apply", "输入 confirmVersion 以执行")}
                  </Label>
                  <Input
                    id="apply-confirmation"
                    value={confirmation}
                    onChange={(event) => setConfirmation(event.target.value)}
                    placeholder={expectedConfirmation || "confirmVersion"}
                  />
                </div>
              </div>
              <Button
                type="submit"
                variant="destructive"
                disabled={isApplying || !canSubmitApply}
              >
                <Rocket className={isApplying ? "animate-spin" : ""} />
                {isApplying
                  ? copy(locale, "Applying", "执行中")
                  : copy(locale, "Apply update", "执行更新")}
              </Button>
            </form>
          </>
        ) : null}

        {apply ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <SummaryItem
              label="runId"
              value={formatOptionalText(apply.runId, applyForm.runId)}
            />
            <SummaryItem
              label={copy(locale, "Status", "状态")}
              value={formatOptionalText(apply.status, "-")}
            />
            <SummaryItem
              label="rollback"
              value={formatOptionalText(apply.rollback_status, "-")}
            />
            <SummaryItem
              label={copy(locale, "Healthcheck", "健康检查")}
              value={formatOptionalText(apply.healthcheck_status, "-")}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
