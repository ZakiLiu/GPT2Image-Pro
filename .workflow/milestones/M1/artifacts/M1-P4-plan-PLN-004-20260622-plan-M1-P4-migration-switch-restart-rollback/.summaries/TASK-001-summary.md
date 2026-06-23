# TASK-001 Summary

## 实际修改文件

- `scripts/local-updater.mjs`
- `.workflow/.csv-wave/20260622-execute-scratch-M1-P4-migration-switch-restart-rollback/discoveries.ndjson`
- `.workflow/scratch/20260622-plan-M1-P4-migration-switch-restart-rollback/.summaries/TASK-001-summary.md`

## 实现摘要

- 扩展 `commandNames`、help、dispatch 与 dry-run guard，新增 `apply` / `update` 显式命令入口。
- 新增 `runApply` 骨架与 `preflightApplyRuntime`，只返回预检和安全操作模型，不写 `releases/<version>`，不切 `current`，不调用 `systemctl`。
- 新增 `ALLOWED_SYSTEMD_UNITS`，仅允许 `gpt2image-web.service` 与 `gpt2image-chatgpt-web-proxy.service`，并拒绝 PostgreSQL、Nginx、Docker、Admin、UOL、UI 运行边界。
- 新增 `redactSensitiveText`，遮蔽 `DATABASE_URL`、`BETTER_AUTH_SECRET`、`CHATGPT_WEB_PROXY_SECRET`、`Authorization`、`Cookie`。
- `apply` / `update` 缺少 `--install-root`、`--manifest` 或 `--env-file` 会失败；help 中明确 `--env-file` 文档默认为 `/etc/gpt2image/gpt2image.env`，但必须显式传入。

## Convergence Criteria

1. PASS：`node --check scripts/local-updater.mjs`
   - 证据：退出码 0，无输出。
2. PASS：`rg -n "apply|update|preflightApplyRuntime|ALLOWED_SYSTEMD_UNITS|redactSensitiveText|gpt2image-web\.service|gpt2image-chatgpt-web-proxy\.service|shared/updater\.lock|/etc/gpt2image/gpt2image\.env|shared/staging|releases|current" scripts/local-updater.mjs`
   - 证据：退出码 0，命中 `apply` / `update`、`ALLOWED_SYSTEMD_UNITS`、`redactSensitiveText`、`preflightApplyRuntime`、两个 systemd unit、`current`、`releases`、`shared/staging`、`shared/updater.lock` 和 `/etc/gpt2image/gpt2image.env`。
3. PASS：`node scripts/local-updater.mjs apply --dry-run; if ($LASTEXITCODE -eq 0) { throw "apply dry-run unexpectedly passed" }`
   - 证据：`apply` 原生命令退出码 1，输出 `apply does not support --dry-run; use check, plan, status, or dry-run instead`；`$LASTEXITCODE` 不是 0，因此未触发 throw。PowerShell 外层保留原生命令退出码 1，这是该负向检查的预期结果。
4. PASS：`git diff --check -- scripts/local-updater.mjs`
   - 证据：退出码 0；仅输出工作区换行提示 `LF will be replaced by CRLF`，无 whitespace error。

## 额外验证

- PASS：`node scripts/local-updater.mjs --self-test`，退出码 0，输出 `Local updater self-test passed.`。
- PASS：`node scripts/local-updater.mjs apply` 与 `node scripts/local-updater.mjs update --install-root . --manifest package.json` 均按预期失败，分别提示缺少 `--install-root` 与 `--env-file`。
- PASS：`redactSensitiveText` 本地导入验证可遮蔽 `DATABASE_URL`、`BETTER_AUTH_SECRET`、`CHATGPT_WEB_PROXY_SECRET`、`Authorization`、`Cookie` 示例值。

## 偏离计划及理由

- 未执行真实 `systemctl`、数据库连接、迁移、`releases/<version>` 写入或 `current` 切换；这是任务明确要求的安全骨架边界。
- `preflightApplyRuntime` 中磁盘空间、服务状态和数据库连接以 command boundary / plan 形式返回，不执行命令；理由是本任务只建立安全操作模型，真实 side effect 留给后续任务。
- 未修改 `package.json` 或部署文档；本任务 scope 只允许改 `scripts/local-updater.mjs` 以及必要 summary / discoveries。
