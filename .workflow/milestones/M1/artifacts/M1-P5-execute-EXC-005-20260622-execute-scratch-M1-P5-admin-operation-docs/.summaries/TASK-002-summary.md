# TASK-002 summary

## 实际修改文件

- `packages/shared/src/uol/types.ts`
- `packages/shared/src/uol/operations/index.ts`
- `packages/shared/src/uol/operations/update.ts`
- `packages/shared/src/uol/tests/update.test.ts`
- `.workflow/.csv-wave/20260622-execute-scratch-M1-P5-admin-operation-docs/discoveries.ndjson`
- `.workflow/.csv-wave/20260622-execute-scratch-M1-P5-admin-operation-docs/.summaries/TASK-002-summary.md`

## 实现摘要

- 在 `OperationDomain` 增加 `"update"`。
- 新增 `update.status`、`update.check`、`update.apply` 三个 UOL operation。
- 三个 operation 均声明 `access: { kind: "admin" }` 与 `processLocalState: true`。
- `update.status` 为只读、非破坏性、天然幂等、无副作用。
- `update.check` 为只读、非破坏性、天然幂等，声明 `external-call` 副作用。
- `update.apply` 为写操作、`destructive: true`，声明 `external-call` 与 `audit` 副作用，并要求全局幂等键 `runId`。
- `update.apply` 输入必含 `manifestPath`、`artifactPath`、`runId`、`confirmVersion`。
- 真实 execute 保持 `Not yet wired` stub，等待后续 `apps/web/src/server/uol-bindings.ts` 绑定。

## 验证命令和结果

1. `rg -n '\| "update"|update\.check|update\.status|update\.apply|destructive: true|keyField: "runId"|processLocalState' packages/shared/src/uol/types.ts packages/shared/src/uol/operations/index.ts packages/shared/src/uol/operations/update.ts packages/shared/src/uol/tests/update.test.ts`
   - 结果：通过，命中 update domain、三项 operation、`destructive: true`、`keyField: "runId"` 与 `processLocalState`。
2. `pnpm --filter @repo/shared test -- src/uol/tests/update.test.ts`
   - 结果：通过，`Test Files 1 passed (1)`，`Tests 5 passed (5)`。
3. `pnpm --filter @repo/shared typecheck`
   - 结果：通过，`tsc --noEmit` 退出码 0。
4. `git diff --check -- packages/shared/src/uol/types.ts packages/shared/src/uol/operations/index.ts packages/shared/src/uol/operations/update.ts packages/shared/src/uol/tests/update.test.ts`
   - 结果：通过，退出码 0；仅提示既有 CRLF 工作区转换 warning，不是 whitespace error。
5. 额外格式检查：`pnpm --filter @repo/web exec biome check ../../packages/shared/src/uol/operations/update.ts ../../packages/shared/src/uol/tests/update.test.ts`
   - 结果：通过，`Checked 2 files`，无修复应用。

## 偏离计划说明

无实质偏离。输出 schema 使用 `.passthrough()` 保留 local-updater 后续绑定的非敏感扩展字段兼容性；真实执行仍为 stub，未修改 image generation、credits、payment、storage、moderation 等核心业务路径。
