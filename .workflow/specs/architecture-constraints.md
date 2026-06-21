---
title: "Architecture Constraints"
readMode: required
priority: high
category: arch
keywords:
  - architecture
  - module
  - layer
  - boundary
  - dependency
  - structure
---

# Architecture Constraints

## Module Structure

- `apps/web/` 是 Next.js 16 App Router 主应用，路由位于 `apps/web/src/app`，业务模块位于 `apps/web/src/features`。
- `packages/database/` 只负责 Drizzle ORM schema、数据库连接与迁移资产，通过 `@repo/database` 和 `@repo/database/schema` 暴露。
- `packages/shared/` 承载跨应用业务逻辑：auth、credits、storage、payment、subscription、moderation、system-settings、uol、mcp 等。
- `packages/ui/` 承载可复用 Shadcn/UI 组件，业务组件不应反向污染基础 UI 包。
- `docs/` 是持久记忆和项目事实入口；`.workflow/` 是 Maestro 工作流状态与 specs 入口。

## Layer Boundaries

- 功能优先暴露为 UOL / Operation Registry operation，再按需接入 server-action、api-route、cron、webhook、MCP 或内置 Agent。
- `invokeOperation()` 是权限、能力校验、审计、幂等和错误映射的集中网关；传输层不得重复实现分散逻辑。
- MCP 适配层默认关闭，只能调用 registry operation，不能直接调用底层 service-fn。
- 内置 Agent 与 MCP 共享 registry、Principal、权限模型、幂等与审计装饰。
- 底层 service 自带 `db.transaction` 时，不得在外层再包嵌套事务。

## Dependency Rules

- `apps/web` 可以依赖 `@repo/shared`、`@repo/database`、`@repo/ui`。
- `packages/shared` 可以依赖 `@repo/database` 与 `@repo/ui`，但应避免把 Web 路由细节带入共享业务层。
- `packages/ui` 不应依赖业务包；保持基础 UI 组件和工具函数可复用。
- 数据库 schema 与迁移只在 `packages/database` 维护；业务层通过显式导出使用。
- 机密只来自 `.env.local` 或部署环境，不进入仓库、文档、日志或注释。

## Technology Constraints

- 单一图像管线是 `apps/web/src/features/image-generation/operations.ts` 的 `runImageGenerationForUser`；v1 图片相关 handler 最终必须汇入此管线。
- 财务真相在 `credits_transaction`，`generation` 行仅用于历史与画廊展示。
- 扣费幂等键为 `(user_id, type, source_ref)`；发放和退款幂等键为 `credits_batch(source_type, source_ref)`。
- 套餐能力唯一来源是 `packages/shared/src/subscription/services/plan-capabilities.ts`；新增能力位必须同步 system settings 示例、后台配置面板和测试。
- 迁移使用 `packages/database/drizzle/NNNN_*.sql` 手写幂等 SQL，并同步 `meta/_journal.json`；不要用 `drizzle-kit generate`。
- 内容审核相关路径按 fail-closed 设计时必须显式透传失败语义，不能静默放行。

## Entries

- 2026-06-21：初始化时确认 UOL 目录已存在，`packages/shared/src/uol/operations/index.ts` 通过副作用导入注册全域 operation。
- 2026-06-21：初始化时确认外部 API、图像生成、账号池、积分、订阅、存储、审核和客服均已有对应测试或 UOL 注册文件信号。
