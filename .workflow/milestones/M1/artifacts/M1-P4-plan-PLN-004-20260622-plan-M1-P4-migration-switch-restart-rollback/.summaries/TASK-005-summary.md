# TASK-005 Summary

## 实际修改文件

- `scripts/local-updater.mjs`

## 实现内容

- 新增 `writeApplyJournal()`，持续合并写入 `shared/staging/<run-id>/apply.json`。
- 新增 `runHealthchecks()`，从 manifest 构造 Web HTTP 与 ChatGPT Web proxy TCP probe，默认目标为 `127.0.0.1:3000/api/health` 与 `127.0.0.1:3021`，runner 可注入。
- 新增 `rollbackApplicationLayer()`，健康检查失败后把 `current` 恢复到 `previous_current`，并再次只重启 `gpt2image-web.service` 与 `gpt2image-chatgpt-web-proxy.service`。
- `runApply()` 在切换与重启后执行 healthcheck；失败时写入 rollback journal，执行应用层 rollback，再运行一次 healthcheck 验证回滚后的运行状态。
- journal 明确记录 `rollback_status`、`previous_current`、`healthcheck_results`、`rollback_healthcheck_results` 与 `db_migration_irreversible: true`，不承诺数据库自动回滚。

## 收敛条件验证

- PASS：`node --check scripts/local-updater.mjs`
- PASS：`rg -n "runHealthchecks|rollbackApplicationLayer|writeApplyJournal|apply\.json|rollback_status|previous_current|db_migration_irreversible|127\.0\.0\.1:3000|127\.0\.0\.1:3021" scripts/local-updater.mjs`
  - 证据：匹配到 `runHealthchecks`、`rollbackApplicationLayer`、`writeApplyJournal`、`apply.json`、`rollback_status`、`previous_current`、`db_migration_irreversible` 和两个默认 probe 目标。
- PASS：`node -e "const fs=require('fs'); const t=fs.readFileSync('scripts/local-updater.mjs','utf8'); for (const s of ['rollbackApplicationLayer','previous_current','gpt2image-web.service','gpt2image-chatgpt-web-proxy.service','db_migration_irreversible']) if (!t.includes(s)) throw new Error(s);"`
- PASS：`rg -n "current|releases|shared/staging|shared/updater\.lock|/etc/gpt2image/gpt2image\.env|数据库.*不可.*回滚|DB migration" scripts/local-updater.mjs docs/deployment/binary-style-deployment.md`
  - 证据：脚本与文档均保留 current/release/staging/lock/env 和数据库迁移不可自动回滚边界。
- PASS：`git diff --check -- scripts/local-updater.mjs`
  - 证据：命令退出码为 0，仅提示工作区 LF 将由 Git 触碰时转 CRLF，不是 whitespace error。
- PASS：注入 runner smoke test
  - 命令：`node --input-type=module -e "... runHealthchecks/rollbackApplicationLayer ..."`
  - 证据：输出 `{"failed":"failed","rollback":"completed","calls":2,"recovered":true}`；断言失败 healthcheck 触发 rollback，回滚后重启两个白名单 unit，并可再次通过 healthcheck。

## 偏离计划及理由

- healthcheck 默认 runner 使用 Node 内置 `fetch` 与 `net`；测试通过注入 runner 完成，不触达真实生产 URL、真实数据库或真实 systemd。
- rollback 范围严格限定为应用层 `current` 指针和两个白名单 systemd 单元；数据库迁移保持 `db_migration_irreversible=true`，由人工备份或迁移 runbook 处理。
