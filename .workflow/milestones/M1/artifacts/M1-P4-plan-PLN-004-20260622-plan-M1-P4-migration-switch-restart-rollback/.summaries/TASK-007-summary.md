# TASK-007 Summary

## 实际修改文件

- `docs/deployment/binary-style-deployment.md`
- `package.json`
- `.workflow/specs/learnings.md`

## 实现内容

- 新增 M1-P4 本地 apply/update runbook，明确 mutating apply 不提供 `--dry-run`。
- 命令示例显式包含 `--install-root /opt/gpt2image`、`--manifest`、`--env-file /etc/gpt2image/gpt2image.env` 和 `--run-id`。
- 记录执行顺序：`shared/updater.lock` -> `shared/staging` -> `releases/.installing-<run-id>` -> `releases/<version>` -> candidate migrator -> `current` -> restart `gpt2image-web.service` / `gpt2image-chatgpt-web-proxy.service` -> healthcheck -> rollback。
- 新增 rollback runbook：读取 `shared/staging/<run-id>/apply.json`，恢复 `previous_current`，保留失败 `releases/<version>`、`shared/staging` 与日志，说明 DB migration 不自动 rollback。
- `package.json` 只新增安全脚本 `updater:self-test:apply`，未新增危险的无参数 `updater:apply`。
- 明确 Admin Operation、UOL operation、server action、api route 和后台 UI 留到 M1-P5，不修改 `apps/web` 或 `packages/shared/src/uol`。
- 通过 `maestro spec add learning` 沉淀 M1-P4 apply/rollback 边界。

## 收敛条件验证

- PASS：`node -e "const p=require('./package.json'); if (!p.scripts['updater:self-test:apply'] && !p.scripts['updater:apply']) throw new Error('missing M1-P4 updater script marker');"`
- PASS：`rg -n "M1-P4|apply|update|--self-test apply|shared/updater\.lock|shared/staging|releases|current|gpt2image-web\.service|gpt2image-chatgpt-web-proxy\.service|/etc/gpt2image/gpt2image\.env" docs/deployment/binary-style-deployment.md package.json`
- PASS：`rg -n "Admin Operation|UOL operation|server action|api route|后台 UI|M1-P5" docs/deployment/binary-style-deployment.md`
- PASS：`node --check scripts/local-updater.mjs`
- PASS：`node scripts/local-updater.mjs --self-test`
  - 证据：输出 `Local updater self-test passed.`
- PASS：`node scripts/local-updater.mjs --self-test apply`
  - 证据：输出 `Local updater apply self-test passed.`
- PASS：`node scripts/verify-binary-release-bundle.mjs --self-test`
  - 证据：输出 `Binary release bundle verifier self-test passed.`
- PASS：`pnpm verify:binary-contract`
  - 证据：输出 `Binary deployment contract verification passed.`
- PASS：`pnpm lint`
  - 证据：Turbo 退出码为 0；存在历史 warning，但没有 error。
- PASS：`pnpm test`
  - 证据：`@repo/web` 47 files / 403 tests passed，`@repo/shared` 42 files / 511 tests passed。
- PASS：`pnpm typecheck`
  - 证据：`@repo/database`、`@repo/shared`、`@repo/ui`、`@repo/web` 均通过。
- PASS：`git diff --check -- scripts/local-updater.mjs scripts/binary-style-release-lib.mjs package.json docs/deployment/binary-style-deployment.md .workflow/roadmap.md`
  - 证据：命令退出码为 0，仅提示 Windows 工作区 LF/CRLF 转换 warning。
- PASS：`node -e "const cp=require('child_process'); const out=cp.execSync('git diff --name-only -- apps/web packages/shared/src/uol').toString().trim(); if (out) throw new Error(out);"`

## 偏离计划及理由

- 为兼容既有 `verify:binary-contract`，保留文档固定短语 `当前仍不表示在线 updater`，并将其限定为 M1-P2 release assets 的历史边界；这样不否认 M1-P4 已落地本地 apply/update。
- 未新增 `updater:apply` package script，避免无参数命令误触生产更新。
