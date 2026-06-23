# TASK-002 summary

## 实际修改文件

- `scripts/local-updater.mjs`
- `.workflow/scratch/20260622-plan-M1-P4-migration-switch-restart-rollback/.summaries/TASK-002-summary.md`
- `.workflow/.csv-wave/20260622-execute-scratch-M1-P4-migration-switch-restart-rollback/discoveries.ndjson`

## 实现内容

- 新增 `resolveReleasePaths()`：解析 `releases/<version>`、`releases/.installing-<run-id>`、`current`、`shared/staging/<run-id>/stage`，并使用 `resolve`、`lstat`、`realpath`、`readlink` 验证路径边界。
- 新增 `installStagedRelease()`：只接受 `stageArtifact()` 返回的 `bundleDir`，先复制到 `releases/.installing-<run-id>`，复验 `verifyRequiredPaths`、`verifyDeniedPaths`、`verifySha256Sums` 与内置 manifest 后，再原子 `rename` 到 `releases/<version>`。
- 收紧 `run-id`：拒绝空值、路径穿越、绝对路径、Windows drive path、斜杠分隔和异常字符。
- 接入 `apply/update --artifact-file` 的阶段性安装路径；未提供 artifact 时仍只返回预检模型，不切换 `current`、不执行 migration、不调用 `systemctl`。
- 失败清理限定为本次 `releases/.installing-<run-id>`，不删除 `current`、旧 `releases`、`shared/staging` 或 `shared/updater.lock`。

## Convergence criteria

1. PASS：`node --check scripts/local-updater.mjs`
   - 证据：退出码 0，无输出。
2. PASS：`rg -n "installStagedRelease|resolveReleasePaths|releases/\.installing|releases|shared/staging|current|lstat|realpath|readlink|verifySha256Sums" scripts/local-updater.mjs`
   - 证据：退出码 0，命中 `installStagedRelease`、`resolveReleasePaths`、`releases/.installing-<run-id>`、`lstat`、`realpath`、`readlink`、`verifySha256Sums` 等关键项。
3. PASS：`node -e "const fs=require('fs'); const t=fs.readFileSync('scripts/local-updater.mjs','utf8'); for (const s of ['releases','.installing','shared/staging','current']) if (!t.includes(s)) throw new Error(s);"`
   - 证据：退出码 0，无输出。
4. PASS：`git diff --check -- scripts/local-updater.mjs`
   - 证据：退出码 0；仅有 Git 的 LF/CRLF 工作区提示，无 whitespace error。

## 额外验证

- PASS：`node scripts/local-updater.mjs --self-test stage`，输出 `Local updater stage self-test passed.`。
- PASS：`node scripts/local-updater.mjs --self-test`，输出 `Local updater self-test passed.`。
- PASS：临时 fixture smoke 使用 `stageArtifact()` 加 `installStagedRelease()` 完成安装，确认生成 `releases/v0.0.2-alpha.0` 且未残留 `.installing-*`。

## 偏离计划及理由

- 计划允许 `.installing` 后复制或 rename。本实现选择复制而非移动 staged bundle，理由是失败时必须保留 `shared/staging/<run-id>/stage` 供排障。
- 内置 bundle manifest 的 `artifact_sha256` 不与 detached manifest 做相等比较，理由是现有 bundle builder 会在 bundle 内写入占位 hash，真实 archive hash 以 detached manifest 为准；仍校验内置 manifest schema、版本、commit、platform、minimum supported version 和 migration mode。
- `apply/update` 仅在显式提供 `--artifact-file` 时安装 release；未提供时保持 TASK-001 的预检模型，避免破坏后续 migration、current switch、systemd restart 和 rollback 的串行边界。
