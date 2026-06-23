# TASK-001 Summary

## 实际修改文件

- `scripts/build-binary-release-bundle.mjs`：在 `assembleBundle` 中把 `scripts/local-updater.mjs` 与 `scripts/binary-style-release-lib.mjs` 复制到 bundle 的 `scripts/` 目录。
- `scripts/binary-style-release-lib.mjs`：在 `requiredBundlePaths` 中加入两个 updater runtime 脚本，verifier 与 local updater stage/apply 共同校验它们存在。
- `docs/deployment/binary-style-deployment.md`：明确 bundle 内 updater runtime 脚本清单，并记录生产推荐 `UPDATER_SCRIPT_PATH=/opt/gpt2image/current/scripts/local-updater.mjs`。
- `.workflow/.csv-wave/20260622-execute-scratch-M1-P5-admin-operation-docs/.summaries/TASK-001-summary.md`：记录本任务修改、验证和偏离计划说明。
- `.workflow/.csv-wave/20260622-execute-scratch-M1-P5-admin-operation-docs/discoveries.ndjson`：追加一条 `implementation_note`。

## 验证命令和结果

1. `rg -n "scripts/local-updater.mjs|scripts/binary-style-release-lib.mjs" scripts/build-binary-release-bundle.mjs scripts/binary-style-release-lib.mjs docs/deployment/binary-style-deployment.md`
   - 结果：通过。命中 build copy、requiredBundlePaths、部署文档 runtime 路径与推荐 `UPDATER_SCRIPT_PATH`。
2. `node scripts/verify-binary-release-bundle.mjs --self-test`
   - 结果：通过，输出 `Binary release bundle verifier self-test passed.`。
3. `node scripts/local-updater.mjs --self-test`
   - 结果：通过，输出 `Local updater self-test passed.`。
4. `node scripts/local-updater.mjs --self-test apply`
   - 结果：通过，输出 `Local updater apply self-test passed.`。
5. `git diff --check -- scripts/build-binary-release-bundle.mjs scripts/binary-style-release-lib.mjs docs/deployment/binary-style-deployment.md`
   - 结果：通过，退出码 0。命令仅提示工作区未来可能 CRLF 转换，未发现 whitespace error。
6. `node --check scripts/build-binary-release-bundle.mjs; node --check scripts/binary-style-release-lib.mjs`
   - 结果：通过，退出码 0，无语法错误。

## 偏离计划说明

- 无偏离。未新增 `updater:apply` package script，未修改 `scripts/local-updater.mjs` 的 apply/update 行为。
- denylist 未误伤 `bundle/scripts`：根级禁入集合仍只覆盖 `.env`、`.gpt2image`、`storage`、`secrets`、`logs` 等运行态或敏感目录，`scripts/` 不在禁入根集合中；本次只复制两个 `.mjs` runtime 文件，不复制 `.env`、secrets、logs、storage 或 `.gpt2image`。
