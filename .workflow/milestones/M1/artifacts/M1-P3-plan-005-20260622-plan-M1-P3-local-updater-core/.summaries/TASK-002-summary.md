# TASK-002 执行摘要

## 上下文

- prev_context：TASK-001 已抽取 binary-style release 校验 helper 到 `scripts/binary-style-release-lib.mjs`，verifier 只保留 CLI/self-test；import smoke、self-test、import grep、export grep、diff check 均通过。
- shared discoveries：已读取 `discoveries.ndjson`，确认 TASK-001 暴露了可复用的 binary-style release verifier helper。

## 实际修改文件

- `scripts/local-updater.mjs`：新增本地 updater CLI skeleton，包含 `check`、`plan`、`status`、`dry-run`、`--help`、`--self-test cli`；命令保持 Phase 3 只读边界，不写 `current`、`releases`，不执行 migrations、systemd restart 或 healthcheck rollback。
- `package.json`：新增 `updater:check`、`updater:plan`、`updater:status`、`updater:dry-run` scripts。
- `.workflow/.csv-wave/20260622-execute-scratch-M1-P3-local-updater-core/discoveries.ndjson`：追加 TASK-002 可复用 CLI skeleton 模式。
- `.workflow/scratch/20260622-plan-M1-P3-local-updater-core/.summaries/TASK-002-summary.md`：记录本摘要。

## 验证命令与证据

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| `node scripts/local-updater.mjs --help` | PASS | exit=0；输出包含 Usage、`check`、`plan`、`status`、`dry-run`、`--self-test cli` 和 Phase 3 boundary。 |
| `node scripts/local-updater.mjs --self-test cli` | PASS | exit=0；输出 `Local updater CLI self-test passed.`；覆盖 help、未知命令、缺少 `--manifest`、dry-run 不写 install root。 |
| `node scripts/local-updater.mjs status --install-root . --dry-run` | PASS | exit=0；输出 JSON，`dryRun: true`，只报告 `current-version`、`manifest.json`、`current/manifest.json` 的存在状态。 |
| `rg -n "check\|plan\|status\|dry-run\|self-test" scripts/local-updater.mjs` | PASS | exit=0；匹配命令集合、帮助文本、dispatch 分支与 self-test 断言。 |
| `rg -n '"updater:check"\|"updater:plan"\|"updater:status"\|"updater:dry-run"' package.json` | PASS | exit=0；命中 package.json 第 19-22 行。 |
| `git diff --check -- scripts/local-updater.mjs package.json` | PASS | exit=0；无 whitespace error；仅提示 package.json 工作区 LF 将按 Git 配置转 CRLF。 |
| `node -e "await import('./scripts/local-updater.mjs'); console.log('import ok')"` | PASS | exit=0；输出 `import ok`，确认 import guard 不触发 CLI 主流程。 |
| `node --check scripts/local-updater.mjs` | PASS | exit=0；语法检查通过。 |

附加尝试：`pnpm exec biome lint scripts/local-updater.mjs package.json` 未作为收敛条件；当前工作区未暴露 `biome` 可执行文件，命令以 `Command "biome" not found` 结束，未反映本次代码语法或收敛失败。

## 计划偏差

- `status` 在未传 `--install-root` 时会以仓库根目录作为本地 dry-run 默认值；这样 package script `updater:status` 可直接本地查看只读状态。缺值参数失败仍由 `check`/`plan`/`dry-run` 缺少 `--manifest` 覆盖。
- 除上述默认值外，无偏离：未接入 current symlink 切换、migrations、systemd restart、healthcheck rollback、Admin/UOL/UI。