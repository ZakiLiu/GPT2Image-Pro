# TASK-003 Summary

## 实际修改文件

- `scripts/local-updater.mjs`

## 实现内容

- 新增 `runCandidateMigration()`，只在已安装的 `releases/<version>/migrator` 下执行 candidate 迁移，不使用 `current`。
- 新增可注入 `runner`，默认 runner 使用 `spawnSync` 且不经 shell；测试可注入替身，避免触发真实数据库或 systemd。
- 新增运行态 env 值读取，仅注入子进程，不把值写入日志或 JSON。
- 迁移命令顺序固定为 `corepack enable`，随后 `pnpm --dir packages/database db:migrate`。
- stdout、stderr、error 均通过 `redactSensitiveText()` 后写入 `/var/log/gpt2image/updater.log` 与 `shared/staging/<run-id>/apply.json`。
- `apply.json` 记录 `migration_started_at`、`migration_finished_at`、`migration_status`、`candidate_release`、`candidate_migrator`、`db_migration_irreversible: true`。
- `runApply()` 的 artifact 路径顺序更新为 `preflightApplyRuntime -> stageArtifact -> installStagedRelease -> runCandidateMigration`；迁移失败会抛错并停在 `current` 切换前。

## 收敛条件验证

- PASS：`node --check scripts/local-updater.mjs`
- PASS：`rg -n "runCandidateMigration|releases/.*/migrator|packages/database db:migrate|migration_started_at|migration_finished_at|db_migration_irreversible|redactSensitiveText|apply\.json" scripts/local-updater.mjs`
  - 证据：匹配到 `runCandidateMigration`、`releases/<version>/migrator`、`pnpm --dir packages/database db:migrate`、`migration_started_at`、`migration_finished_at`、`db_migration_irreversible`、`redactSensitiveText`、`apply.json`。
- PASS：`node -e "const fs=require('fs'); const t=fs.readFileSync('scripts/local-updater.mjs','utf8'); const m=t.indexOf('runCandidateMigration'); const s=t.indexOf('switchCurrentSymlink'); if (m < 0) throw new Error('missing migration'); if (s >= 0 && m > s) throw new Error('migration after switch');"`
  - 证据：命令退出码为 0；当前尚未实现 `switchCurrentSymlink`，迁移逻辑已存在且不会排在切换之后。
- PASS：`rg -n "数据库迁移|DB migration|不可自动回滚|pre_switch|current" scripts/local-updater.mjs docs/deployment/binary-style-deployment.md`
  - 证据：脚本中记录 `DB migration`、`pre_switch`、`current` 与数据库迁移不可自动回滚说明；文档中已有同类边界说明。
- PASS：`git diff --check -- scripts/local-updater.mjs`
  - 证据：命令退出码为 0，仅提示工作区 LF 将由 Git 触碰时转 CRLF，不是 whitespace error。
- PASS：注入 runner smoke test
  - 命令：`node --input-type=module -e "... runCandidateMigration({ runner: fake }) ..."`
  - 证据：输出 `{"status":"completed","calls":["corepack","pnpm"],...}`；断言 cwd 指向 `v0.0.1-alpha.0/migrator`，env 已注入，`apply.json` 未泄漏 secret 或 token。

## 偏离计划及理由

- 计划中的 `runApply` 顺序描述包含未来的 `switchCurrentSymlink`，本任务只实现到 `runCandidateMigration` 并继续阻断 `current` 切换、systemd restart 与 healthcheck rollback；这些由 TASK-004 和 TASK-005 处理。
- 为满足真实迁移执行，新增了 env 值解析；该值只进入子进程环境，不写入 updater log 或 `apply.json`，并通过 smoke test 验证脱敏。
