---
title: "Coding Conventions"
readMode: required
priority: high
category: coding
keywords:
  - style
  - naming
  - import
  - pattern
  - convention
  - formatting
---

# Coding Conventions

## Formatting

- 使用 TypeScript strict；根 `tsconfig.base.json` 开启 `noImplicitAny`、`noUncheckedIndexedAccess`、`noUnusedLocals`、`noUnusedParameters` 等严格规则。
- 禁止显式 `any`；不确定输入使用 `unknown`，先经 Zod 或类型守卫收窄后再使用。
- Biome 是统一格式与 lint 入口：2 空格缩进、双引号、分号、行宽 80。
- 不使用 emoji；回复、文档、注释、代码、提交信息均保持纯文本表达。
- 注释使用简体中文，说明职责、使用方、关键依赖、边界、失败模式和复杂逻辑的 WHY。

## Naming

- 命名必须见名知意；函数小而专注，文件保持单一职责。
- `apps/web/src/features/<domain>/` 承载业务功能；测试文件通常与业务文件相邻，命名为 `*.test.ts` 或 `*.test.tsx`。
- `packages/shared/src/<domain>/` 承载可复用业务逻辑，通过 `package.json` 的 `exports` 显式暴露。
- `packages/ui/src/components/` 承载 Shadcn/UI 组件，导出路径为 `@repo/ui/components/<name>`。

## Imports

- 跨包依赖使用 `@repo/*`：`@repo/database`、`@repo/shared/<module>`、`@repo/ui/components/<name>`。
- `apps/web` 包内导入使用 `@/*` 指向 `apps/web/src/*`。
- 同目录或同包内部工具可使用相对路径；跨层级共享能力优先抽到 `packages/shared`。
- 类型导入优先使用 `import type`，满足 Biome `useImportType` 规则。
- i18n 路由和导航从 `@/i18n/routing` 取，不自行拼接本地化路由。

## Patterns

- 新功能优先注册为 UOL operation：在 `packages/shared/src/uol/operations/` 使用 `defineOperation()`，声明 Zod 输入、输出、权限、能力位、副作用、破坏性和幂等策略。
- 传输层保持薄适配：解析请求、构造 Principal、调用 `invokeOperation()` 或既有 service，再编码响应。
- Server Action 走 `protectedAction` 或 `adminAction`，不得绕开权限边界直接执行敏感写入。
- 可选服务如 Redis、Axiom、Sentry 未配置时必须优雅降级。
- 不保留死代码、被注释掉的旧实现、墓碑注释或伪完成 TODO。

## Entries

- 2026-06-21：初始化 Maestro specs 时确认本仓库是 pnpm + Turbo + Next.js 16 + React 19 + TypeScript strict monorepo。
- 2026-06-21：代码风格以 `AGENTS.md` / `CLAUDE.md` 和 Biome 配置为准，写代码前先读相邻 3 个以上模式。
