# TASK-006 执行摘要

## 上下文

- TASK-001 至 TASK-005 已完成 helper 抽取、CLI skeleton、manifest check、download verification、lock/stage 预检边界。
- 本任务负责文档同步与 final gate 收口。

## 实际修改文件

- `docs/deployment/binary-style-deployment.md`：新增 M1-P3 本地 updater CLI 章节，说明 `updater:check`、`updater:plan`、`updater:status`、`updater:dry-run`、download、stage、`shared/staging`、`updater.lock`、`.partial`、env preflight 和 Phase 4/5 禁入边界。
- `.workflow/.csv-wave/20260622-execute-scratch-M1-P3-local-updater-core/discoveries.ndjson`：追加 TASK-006 文档收口记录。
- `.workflow/scratch/20260622-plan-M1-P3-local-updater-core/.summaries/TASK-006-summary.md`：记录本摘要。

## 验证命令与证据

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| `rg -n "updater:check\|updater:plan\|updater:status\|updater:dry-run\|shared/staging\|updater.lock\|\.partial" docs/deployment/binary-style-deployment.md package.json` | PASS | exit=0；命中文档与 package scripts。 |
| `rg -n "node scripts/local-updater.mjs --self-test\|node scripts/verify-binary-release-bundle.mjs --self-test\|pnpm verify:binary-contract\|pnpm verify:binary-bundle" docs/deployment/binary-style-deployment.md` | PASS | exit=0；命中 Phase 3 final gate 命令块。 |
| `node scripts/local-updater.mjs --self-test` | PASS | exit=0；输出 `Local updater self-test passed.`。 |
| `node scripts/verify-binary-release-bundle.mjs --self-test` | PASS | exit=0；输出 `Binary release bundle verifier self-test passed.`。 |
| `pnpm verify:binary-contract` | PASS | exit=0；输出 `Binary deployment contract verification passed.`。 |
| `git diff --check -- scripts/binary-style-release-lib.mjs scripts/verify-binary-release-bundle.mjs scripts/local-updater.mjs package.json docs/deployment/binary-style-deployment.md` | PASS | exit=0；无 whitespace error，仅 Git CRLF 工作区提示。 |

## 计划偏差

- 未运行 `pnpm verify:binary-bundle` smoke，因为当前工作区没有 M1-P2 `dist/binary-style/v0.0.0-alpha.0` smoke bundle；文档已明确没有 smoke bundle 时先按 M1-P2 命令生成再执行。
- 无 Phase 4/5 越界行为。
