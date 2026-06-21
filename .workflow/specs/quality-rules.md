---
title: "Quality Rules"
readMode: required
priority: high
category: review
keywords:
  - quality
  - lint
  - typecheck
  - ci
  - build
  - gate
---

# Quality Rules

## Local Gates

- 常规质量门：`pnpm turbo typecheck`、`pnpm turbo lint`、`pnpm turbo test`。
- Web 单包：`pnpm --filter @repo/web lint`、`pnpm --filter @repo/web test`、`pnpm --filter @repo/web typecheck`。
- Shared 单包：`pnpm --filter @repo/shared test`、`pnpm --filter @repo/shared typecheck`。
- 数据库包：`pnpm --filter @repo/database typecheck`。
- 改动前后若只影响特定模块，先跑最近测试，再视影响面跑 monorepo 质量门。

## CI Gates

- `docs-mirror` 要求 `CLAUDE.md` 与 `AGENTS.md` 逐字一致。
- PR lint 使用 Biome changed-files 检查；push 和 PR 都跑 typecheck 与 unit tests。
- Typecheck 前 CI 会执行 `pnpm --filter @repo/web exec fumadocs-mdx` 生成 Fumadocs `.source`。
- Docker release 只在 tag 或手动触发时构建 GHCR 镜像。

## Review Rules

- 不用 `--no-verify` 绕过校验。
- 不通过降低断言、`skip`、删除测试或吞异常制造假绿灯。
- 金额、积分、扣费、配额、支付、订阅、权限、API Key、存储、审核和队列改动必须说明幂等、并发和失败模式。
- 只 stage 当前任务产物，使用 `git add <specific-files>`，不要 `git add .`。

## Entries

- 2026-06-21：初始化时确认 `.github/workflows/ci.yml` 包含 docs mirror、changed-files Biome lint、typecheck、unit tests 等门禁。
