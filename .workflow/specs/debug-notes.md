---
title: "Debug Notes"
readMode: optional
priority: medium
category: debug
keywords:
  - debug
  - pitfall
  - failure
  - workaround
  - command
---

# Debug Notes

## Known Pitfalls

- `maestro kg search <symbol> --code` 在当前本地 CLI 中不可用，会返回 `unknown option '--code'`；需要先用不带 `--code` 的 `maestro kg search` 或直接用源码搜索。
- 当前项目初始化前 MaestroGraph 未建立，`maestro kg search` 会提示 `MaestroGraph not initialized for this project. Run: maestro kg sync`。
- 独立 typecheck 前需要生成 Fumadocs `.source`，CI 使用 `pnpm --filter @repo/web exec fumadocs-mdx`。
- Drizzle 迁移不要用 `drizzle-kit generate`；手写幂等 SQL 并维护 journal。

## Entries

- 2026-06-21：初始化时 `maestro spec init` 成功，但 seed spec 内容为空壳，因此手动根据仓库配置、README、AGENTS、CI 和源码结构补齐首批约束。
