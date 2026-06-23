# TASK-004 执行摘要

## 上下文

- prev_context：TASK-001 已抽取 release 校验 helper；TASK-003 已完成 manifest check、版本比较和非敏感摘要。
- shared discoveries：已读取 `discoveries.ndjson`，沿用 helper 复用与 CLI skeleton 模式。

## 实际修改文件

- `scripts/local-updater.mjs`：新增 `download` 命令、`downloadToPartial`、`downloadArtifact`、`verifyDownloadedArtifact`、`resolveDownloadTarget` 和 detached checksum 解析；下载写入 `.partial`，成功后 `rename`，失败清理 `.partial`，校验失败删除未可信 artifact。
- `.workflow/.csv-wave/20260622-execute-scratch-M1-P3-local-updater-core/discoveries.ndjson`：追加 TASK-004 下载模式。
- `.workflow/scratch/20260622-plan-M1-P3-local-updater-core/.summaries/TASK-004-summary.md`：记录本摘要。

## 验证命令与证据

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| `node scripts/local-updater.mjs --self-test download` | PASS | exit=0；输出 `Local updater download self-test passed.`；覆盖成功 rename、checksum mismatch、artifact filename mismatch、失败清理 `.partial`、重复执行覆盖旧 `.partial`。 |
| `node -e "import('./scripts/local-updater.mjs').then((m)=>{ for (const k of ['downloadArtifact','downloadToPartial','verifyDownloadedArtifact']) { if (typeof m[k] !== 'function') throw new Error(k); } })"` | PASS | exit=0；三个导出函数存在。 |
| `rg -n "\.partial\|rename\(\|artifact_sha256\|verifyArtifact\|sha256File\|checksum" scripts/local-updater.mjs` | PASS | exit=0；命中 `.partial`、`rename`、`artifact_sha256`、`verifyArtifact`、`sha256File` 和 checksum 逻辑。 |
| `node -e "const fs=require('fs'); const text=fs.readFileSync('scripts/local-updater.mjs','utf8'); if (/fs\.symlink|\bsymlink\s*\(|systemctl|db:migrate/i.test(text)) throw new Error('phase 4 behavior found');"` | PASS | exit=0；未发现 symlink、systemctl 或 db:migrate 行为。 |
| `git diff --check -- scripts/local-updater.mjs` | PASS | exit=0；无 whitespace error。 |

## 计划偏差

- 无 Phase 4 越界行为。`download` 会写入 `installRoot/shared/staging/<run-id>/downloads`，但不修改 `current`、不执行 migration、不调用 systemd。
- 额外暴露 `download` 子命令，符合 Phase 3 planned output 中的 download 能力。
