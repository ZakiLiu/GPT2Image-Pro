---
title: "UI Conventions"
readMode: optional
priority: medium
category: ui
keywords:
  - ui
  - component
  - shadcn
  - tailwind
  - react
---

# UI Conventions

## Component System

- 使用 Shadcn/UI，`components.json` 配置为 `new-york` 风格、RSC、TSX、neutral base color、CSS variables。
- 基础 UI 组件从 `@repo/ui/components/<name>` 引入，不在业务模块复制基础组件实现。
- 图标库使用 `lucide-react`。

## React / Next.js

- Server Components 优先；只有需要 browser state、effects、事件处理或客户端 API 时才使用 `'use client'`。
- App Router 路由按 `apps/web/src/app/[locale]/...` 与 route groups 组织。
- i18n 导航使用 `@/i18n/routing`。

## Styling

- 全局样式入口包含 `@repo/ui/globals.css`。
- Tailwind 配置由现有 Next.js / PostCSS / Shadcn 约定驱动；新增样式匹配相邻组件写法。
- 不在 UI 文案、代码注释或组件中使用 emoji。

## Entries

- 2026-06-21：初始化时确认 `components.json` 和 `packages/ui` 导出 Shadcn 组件，Web 应用通过 `@repo/ui` 复用。
