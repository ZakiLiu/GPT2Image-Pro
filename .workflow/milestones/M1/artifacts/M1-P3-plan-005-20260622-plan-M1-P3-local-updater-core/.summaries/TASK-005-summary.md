# TASK-005 执行摘要

## 上下文

- prev_context：TASK-001 helper、TASK-004 下载校验均已完成，artifact SHA256 与 `.partial` 清理路径可复用。
- shared discoveries：已读取 `discoveries.ndjson`，沿用 partial download、manifest check 和 helper 抽取模式。

## 实际修改文件

- `scripts/local-updater.mjs`：新增 `stage` 命令、`acquireUpdateLock`、`releaseUpdateLock`、`assertInsideInstallRoot`、`assertSafeArchiveEntry`、`extractArchiveToStaging`、`stageArtifact`、`preflightRuntimeEnv` 和 `runStageSelfTest`。
- `.workflow/.csv-wave/20260622-execute-scratch-M1-P3-local-updater-core/discoveries.ndjson`：追加 TASK-005 staging/lock 模式。
- `.workflow/scratch/20260622-plan-M1-P3-local-updater-core/.summaries/TASK-005-summary.md`：记录本摘要。

## 验证命令与证据

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| `node scripts/local-updater.mjs --self-test stage` | PASS | exit=0；输出 `Local updater stage self-test passed.`；覆盖 updater.lock 二次加锁失败、archive path traversal 拒绝、stage 成功、缺 env 文件失败、缺 required bundle path 失败、cleanup 不删除 shared sentinel。 |
| `node -e "import('./scripts/local-updater.mjs').then((m)=>{ for (const k of ['acquireUpdateLock','stageArtifact','assertInsideInstallRoot','preflightRuntimeEnv']) { if (typeof m[k] !== 'function') throw new Error(k); } })"` | PASS | exit=0；四个导出函数存在。 |
| `rg -n "shared/staging\|updater\.lock\|assertInsideInstallRoot\|path traversal\|DATABASE_URL\|BETTER_AUTH_SECRET" scripts/local-updater.mjs` | PASS | exit=0；命中 staging、lock、边界断言、path traversal 和 env 名称。 |
| `node -e "const fs=require('fs'); const text=fs.readFileSync('scripts/local-updater.mjs','utf8'); if (/spawn(?:Sync)?\([^)]*(systemctl|db:migrate)|execFile(?:Sync)?\([^)]*(systemctl|db:migrate)|fs\.symlink|\bsymlink\s*\(/i.test(text)) throw new Error('phase 4 action found');"` | PASS | exit=0；未发现 systemctl、db:migrate 或 symlink mutation。 |
| `git diff --check -- scripts/local-updater.mjs` | PASS | exit=0；无 whitespace error。 |

## 计划偏差

- 无 Phase 4 越界行为。`stage` 只写入 `shared/staging`，只做 artifact 解包和本地预检，不切换 `current`，不运行 migrator，不重启 systemd。
- `preflightRuntimeEnv` 只检查 env 文件存在和必需变量名集合，不读取、不打印变量值。
