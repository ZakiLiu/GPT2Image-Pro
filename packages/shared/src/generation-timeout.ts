// 生图超时相关的纯常量与纯函数（无 DB / 无副作用导入）。
//
// WHY 单独成文件：这些值既被带 DB 的 generation-maintenance（pending 清扫）使用，也被
// 纯分类器 sla-classification（SLA 归因，禁止拉 DB 连接）使用。若放在 generation-maintenance
// 里，分类器 import 会经其 `import { db }` 把数据库连接拖进纯路径（无 DATABASE_URL 即抛错）。
// 故抽到 db-free 模块，两侧各取所需。

// 文案须与 generation_error 结算行为一致：退生成费、保留已发生的审核费
// （getFailedGenerationTargetCredits 对 generation_error 保留 moderationOnlyCredits），
// 不能笼统地说 "credits were refunded"。
export const IMAGE_GENERATION_TIMEOUT_ERROR =
  "Image generation timed out after 20 minutes. The image generation fee was refunded; any moderation fee already incurred was retained.";

// Web（ChatGPT 网页）后端的超时常常不是单纯耗时，而是上游对内容的"静默拒绝"——画图
// 工具不返图、SSE 一直挂着，直到 20 分钟被判超时，既没有可解析的拒绝文本，也没有审核
// 码，外观与容量超时完全一致。故 Web 超时补一句"疑似审核拒绝"的提示，并据此在 SLA
// 归因里计入 moderation（见 sla-classification.classifyGenerationError），避免这类隐性
// 审核被淹没在普通平台超时里。MARKER 为稳定的 ASCII 子串，供归因函数匹配。
export const IMAGE_GENERATION_WEB_TIMEOUT_MODERATION_MARKER =
  "suspected upstream content moderation rejection";
export const IMAGE_GENERATION_WEB_TIMEOUT_ERROR = `Image generation timed out after 20 minutes (${IMAGE_GENERATION_WEB_TIMEOUT_MODERATION_MARKER}; 可能为上游内容审核拒绝). The image generation fee was refunded; any moderation fee already incurred was retained.`;

// 按命中后端选择超时文案：Web 账号后端用带"疑似审核"提示的版本；其余（codex/responses
// 账号、外接 API、Adobe）仍用通用版本，避免把容量/网络超时误归审核。
export function resolveImageGenerationTimeoutError(
  backend?: { type?: string | null; accountBackend?: string | null } | null
): string {
  if (backend?.type === "pool-account" && backend?.accountBackend === "web") {
    return IMAGE_GENERATION_WEB_TIMEOUT_ERROR;
  }
  return IMAGE_GENERATION_TIMEOUT_ERROR;
}
