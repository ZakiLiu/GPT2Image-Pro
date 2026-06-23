# TASK-006 Summary

## 实际修改文件

- `scripts/local-updater.mjs`

## 实现内容

- 新增 `runApplySelfTest()` 并导出。
- 扩展 `--self-test` allowlist，支持 `node scripts/local-updater.mjs --self-test apply`，并把 apply 自测纳入默认 `--self-test`。
- 新增 apply fixture，复用 binary-style bundle 最小 tar fixture，不调用真实 systemd、真实数据库或生产 URL。
- 覆盖以下场景：
  - migration failure：候选 migrator 失败后 `current` 保持 previous release，白名单服务不 restart，`shared/updater.lock` 释放。
  - healthcheck rollback：healthcheck 失败后恢复 `previous_current`，两个白名单服务再次 restart，并写入 `rollback_status`。
  - service whitelist：manifest 中出现 `postgresql.service` 时失败。
  - symlink escape：`current` 指向 installRoot/releases 外时失败。
  - secret redaction：`DATABASE_URL`、`BETTER_AUTH_SECRET`、`CHATGPT_WEB_PROXY_SECRET`、`Authorization` 敏感值不进入 `apply.json` 或 updater log。
  - stale lock：已有 `shared/updater.lock` 时报告 lock path 且不自动删除。
- `readUpdateLockSummary()` 现在附带 metadata 摘要和 stale lock 人工处理提示。

## 收敛条件验证

- PASS：`node --check scripts/local-updater.mjs`
- PASS：`node scripts/local-updater.mjs --self-test apply`
  - 证据：输出 `Local updater apply self-test passed.`
- PASS：`node scripts/local-updater.mjs --self-test`
  - 证据：输出 `Local updater self-test passed.`
- PASS：`rg -n "runApplySelfTest|migration failure|healthcheck rollback|service whitelist|symlink escape|secret redaction|stale lock|shared/updater\.lock|db_migration_irreversible" scripts/local-updater.mjs`
  - 证据：匹配到 `runApplySelfTest`、6 类自测名词、`shared/updater.lock` 和 `db_migration_irreversible`。
- PASS：`node -e "import('./scripts/local-updater.mjs').then((m)=>{ if (typeof m.runApplySelfTest !== 'function') throw new Error('runApplySelfTest'); })"`
- PASS：`git diff --check -- scripts/local-updater.mjs`
  - 证据：命令退出码为 0，仅提示工作区 LF 将由 Git 触碰时转 CRLF，不是 whitespace error。

## 偏离计划及理由

- 自测通过注入 `migrationRunner`、`systemctlRunner`、`healthcheckRunner` 完成，不触达真实数据库、真实 `systemctl` 或生产 URL；这是计划要求的安全边界。
- Windows 本地 fixture 对 `current` 使用 junction，生产 binary-style 目标仍是 Linux systemd 环境。
