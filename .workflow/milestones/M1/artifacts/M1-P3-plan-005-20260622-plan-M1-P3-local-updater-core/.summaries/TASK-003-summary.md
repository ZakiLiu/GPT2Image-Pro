# TASK-003 执行摘要

## 上下文

- prev_context：TASK-002 已新增本地 updater CLI skeleton 与 package scripts，CLI 保持只读 `check`、`plan`、`status`、`dry-run`、`self-test` 边界。
- shared discoveries：已读取 `discoveries.ndjson`，复用 TASK-001 helper 抽取和 TASK-002 CLI skeleton 模式。
- 说明：原 Wave 3 worker 未调用 `report_agent_job_result`，本任务由 orchestrator 接手补完并重新验证全部收敛条件。

## 实际修改文件

- `scripts/local-updater.mjs`：新增 `current-version` 参数、manifest 来源读取、`compareProjectVersions`、`decideUpdate`、`readManifestSource`、`runCheck` 白名单摘要、`runCheckSelfTest`，覆盖 upgrade、no-update、downgrade、minimum unsupported、platform mismatch 和 invalid checksum。
- `.workflow/.csv-wave/20260622-execute-scratch-M1-P3-local-updater-core/discoveries.ndjson`：追加 TASK-003 版本决策与 manifest check 模式。
- `.workflow/scratch/20260622-plan-M1-P3-local-updater-core/.summaries/TASK-003-summary.md`：记录本摘要。

## 验证命令与证据

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| `node scripts/local-updater.mjs --self-test check` | PASS | exit=0；输出 `Local updater check self-test passed.`；覆盖 upgrade、same/no-update、downgrade、minimum unsupported、platform mismatch、invalid checksum。 |
| `node scripts/local-updater.mjs check --manifest docs/deployment/binary-style-manifest.example.json --current-version v0.5.6 --platform linux-x64 --dry-run` | PASS | exit=0；JSON 输出 `decision: "upgrade"`、`available_version: "v0.5.7-beta.1"`、`minimum_supported_version: "v0.5.0"`、`artifact_sha256`。 |
| `node -e "import('./scripts/local-updater.mjs').then((m)=>{ for (const k of ['compareProjectVersions','decideUpdate','readManifestSource']) { if (typeof m[k] !== 'function') throw new Error(k); } })"` | PASS | exit=0；三个导出函数存在。 |
| `rg -n "minimum_supported_version\|compareProjectVersions\|decideUpdate\|readManifestSource\|artifact_sha256" scripts/local-updater.mjs` | PASS | exit=0；命中版本决策、manifest 来源读取和 checksum 字段。 |
| `git diff --check -- scripts/local-updater.mjs` | PASS | exit=0；无 whitespace error。 |

## 计划偏差

- 无功能边界偏离。仍未实现下载、staging、current symlink 切换、migration、systemd restart、healthcheck rollback、Admin/UOL/UI。
- 因 worker 未按契约回报，本任务不是使用其结果自报完成，而是由 orchestrator 重新运行全部收敛命令后标记完成。
