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


<spec-entry category="learning" keywords="node22 pnpm build-web go1.24 binary-style" date="2026-06-22" title="M1-P2 local verification environment" description="Use Node 22 and build-time env for M1-P2 local smoke" source="execute:.workflow/scratch/20260622-plan-M1-P2-release-bundle-ci-assets">

### M1-P2 local verification environment

本机 Node 24.4.1 执行 pnpm install 在该仓库触发 heap out of memory；切到项目/CI 使用的 Node 22.22.2 后 pnpm install --frozen-lockfile 正常完成。M1-P2 smoke 还需要 build-time placeholder env 才能让 pnpm build:web 收集 page data，并临时下载 Go 1.24.13 执行 sidecar test/build。

</spec-entry>

<spec-entry category="learning" keywords="m1-p4 updater apply rollback systemd" date="2026-06-22" title="M1-P4 local updater apply rollback boundary" description="M1-P4 updater apply rollback scope and CLI safety boundary" source="execute:.workflow/scratch/20260622-plan-M1-P4-migration-switch-restart-rollback">

### M1-P4 local updater apply rollback boundary

M1-P4 apply/update 只恢复应用层 current 与 gpt2image-web.service、gpt2image-chatgpt-web-proxy.service；数据库 migration 成功后不自动 rollback。生产命令必须显式提供 --install-root /opt/gpt2image、--manifest、--env-file /etc/gpt2image/gpt2image.env、--run-id 和 artifact 路径，package.json 只暴露 updater:self-test:apply，Admin/UOL/UI 留到 M1-P5。

</spec-entry>

<spec-entry category="learning" keywords="m1-p5,updater,uol,admin,mcp" date="2026-06-22" title="M1-P5 admin updater UOL boundary" description="Default-off admin updater operations and MCP destructive guardrails" source="execute:.workflow/scratch/20260622-plan-M1-P5-admin-operation-docs">

### M1-P5 admin updater UOL boundary

M1-P5 将 online updater 暴露为默认关闭的 Admin Operation：update.status/update.check/update.apply 先注册到 UOL，apps/web 通过 server-only wrapper late binding 到 local-updater.mjs。生产必须由服务端 env 提供 UPDATER_ENABLED、UPDATER_SCRIPT_PATH、UPDATER_INSTALL_ROOT、UPDATER_ENV_FILE；请求体不得覆盖 install root 或 env file。MCP 生产侧可用 MCP_READ_ONLY=1 或 MCP_DENIED_OPS=update.apply 阻断 destructive apply。

</spec-entry>