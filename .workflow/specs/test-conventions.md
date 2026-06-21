---
title: "Test Conventions"
readMode: required
priority: high
category: test
keywords:
  - test
  - coverage
  - mock
  - fixture
  - assertion
  - framework
---

# Test Conventions

## Framework

- 使用 Vitest；`apps/web`、`packages/shared` 和根 `src/test` 均存在测试。
- `packages/shared` 和 `apps/web` 的核心测试应保持 DB-free；纯函数优先抽到不 import `@repo/database` 的模块后再测。
- React 相关测试通过 Vite React plugin 支持。

## Directory Structure

- 业务模块测试优先与被测文件相邻：`apps/web/src/features/<domain>/*.test.ts`。
- API route 测试可放在对应 route 目录下，例如 `apps/web/src/app/api/.../route.test.ts`。
- 共享包测试放在 `packages/shared/src/<domain>/*.test.ts` 或 `packages/shared/src/uol/tests/*.test.ts`。
- 根 `src/test/` 存在历史测试目录，维护时不要误删，迁移前先确认引用与运行方式。

## Naming Conventions

- 测试文件使用 `*.test.ts` 或 `*.test.tsx`。
- 测试名称描述行为和边界，不只复述函数名。
- 回归测试应在标题中体现失败条件或业务场景。

## Patterns

- 修 Bug 先写复现测试再修。
- 核心逻辑覆盖正常、边界、失败、并发或重复请求，尤其是 credits、payment、subscription、auth、idempotency、API、storage、moderation。
- 不使用 `skip`、注释断言或弱化断言绕过失败。
- 计费、退款、扣费和发放测试必须验证幂等键和流水结果。

## Entries

- 2026-06-21：初始化扫描发现外部 API、图像生成、账号池、支付、PSD、存储、安全、MCP、UOL、订阅能力矩阵等模块均已有 Vitest 测试信号。
