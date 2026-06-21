---
title: "Learnings"
readMode: optional
priority: medium
category: learning
keywords:
  - learning
  - lesson
  - pitfall
  - decision
  - context
---

# Learnings

## Format

新增经验按以下格式记录：

```markdown
## YYYY-MM-DD - 标题

- **Context**: 触发背景。
- **Observation**: 实际发现。
- **Decision**: 后续采用的做法。
- **Evidence**: 相关命令、文件或测试。
```

## Entries

## 2026-06-21 - Maestro 初始化接管已有代码库

- **Context**: 用户确认这是新的 Maestro 项目，但仓库本身已有完整代码和一个 `.workflow/wiki-index.json`。
- **Observation**: `.workflow/state.json` 不存在，符合补齐初始化结构的条件；已有 `.workflow/wiki-index.json` 不应被覆盖。
- **Decision**: 保留 `wiki-index.json`，只创建缺失的 `.workflow/project.md`、`.workflow/state.json`、`.workflow/config.json`、`specs/`、`scratch/`、`codebase/`。
- **Evidence**: `git status --short --branch` 显示 `?? .workflow/`；`maestro spec init` 成功创建 seed spec 文件。
