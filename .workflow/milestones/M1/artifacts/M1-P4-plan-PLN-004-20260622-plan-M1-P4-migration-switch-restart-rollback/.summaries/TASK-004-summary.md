# TASK-004 Summary

## 实际修改文件

- `scripts/local-updater.mjs`

## 实现内容

- 新增 `capturePreviousCurrent()`，切换前读取 `current` 指针、上一版 release 路径和 manifest 摘要，并验证上一版位于 `releases` 内。
- 新增 `switchCurrentSymlink()`，在迁移成功后创建 `current.next` 指向候选 `releases/<version>`，验证后替换 `current`。
- 新增 `restartWhitelistedServices()`，只允许 `systemctl restart gpt2image-web.service` 与 `systemctl restart gpt2image-chatgpt-web-proxy.service`，runner 可注入。
- 新增 `mergeApplyProgress()`，把 `previous_current`、`current_target`、`switched_at`、`restarted_units` 写回 `shared/staging/<run-id>/apply.json`。
- `runApply()` 顺序推进到 `preflight -> stageArtifact -> installStagedRelease -> runCandidateMigration -> capturePreviousCurrent -> switchCurrentSymlink -> restartWhitelistedServices`，仍阻断 PostgreSQL、Nginx、Docker、Admin、UOL、UI。

## 收敛条件验证

- PASS：`node --check scripts/local-updater.mjs`
- PASS：`rg -n "capturePreviousCurrent|switchCurrentSymlink|current\.tmp|current\.next|restartWhitelistedServices|assertAllowedSystemdUnits|gpt2image-web\.service|gpt2image-chatgpt-web-proxy\.service|systemctl" scripts/local-updater.mjs`
  - 证据：匹配到 `capturePreviousCurrent`、`switchCurrentSymlink`、`current.next`、`restartWhitelistedServices`、`assertAllowedSystemdUnits`、两个白名单 systemd unit 与 `systemctl`。
- PASS：`node -e "const fs=require('fs'); const t=fs.readFileSync('scripts/local-updater.mjs','utf8'); if(!t.includes('gpt2image-web.service')||!t.includes('gpt2image-chatgpt-web-proxy.service')) throw new Error('missing whitelist'); if(/systemctl[^\n]*(postgres|nginx|docker)/i.test(t)) throw new Error('broad systemd target');"`
  - 证据：命令退出码为 0，未发现 `systemctl` 宽泛目标。
- PASS：`rg -n "current|releases|shared/staging|shared/updater\.lock|/etc/gpt2image/gpt2image\.env" scripts/local-updater.mjs`
  - 证据：脚本保留所有要求的边界名词。
- PASS：`git diff --check -- scripts/local-updater.mjs`
  - 证据：命令退出码为 0，仅提示工作区 LF 将由 Git 触碰时转 CRLF，不是 whitespace error。
- PASS：注入 runner smoke test
  - 命令：`node --input-type=module -e "... capturePreviousCurrent/switchCurrentSymlink/restartWhitelistedServices ..."`
  - 证据：输出 `{"previous":true,"target":"v0.0.1-alpha.0","calls":["systemctl restart gpt2image-web.service","systemctl restart gpt2image-chatgpt-web-proxy.service"],"restarted":2,...}`。

## 偏离计划及理由

- Linux 生产路径使用 `rename(current.next, current)` 原子替换。Windows 本地 smoke fixture 无法总是原子覆盖 junction，因此保留仅限 Windows symlink fixture 的 fallback；生产 binary-style 目标仍是 Linux systemd 环境。
- TASK-004 只做到切换与白名单重启，健康检查与失败回滚留给 TASK-005。
