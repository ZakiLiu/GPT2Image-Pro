# TASK-006 Summary

## Result
completed

## Files modified
- `packages/shared/src/mcp/tool-factory.test.ts`
- `docs/deployment/binary-style-deployment.md`

## Implementation notes
- Added MCP tool-factory tests for bound `update.status` and `update.apply` exposure.
- Verified `update.apply` carries `destructiveHint` by default when bound.
- Verified `MCP_READ_ONLY=1` hides destructive `update_apply` while keeping `update_status` visible.
- Verified `MCP_DENIED_OPS=update.apply` hides `update_apply`.
- Verified an unbound `update.apply` stub is not exposed.
- Documented production MCP guardrails recommending `MCP_READ_ONLY=1` or `MCP_DENIED_OPS=update.apply`.

## Verification
- `rg -n "update_apply|MCP_READ_ONLY|MCP_DENIED_OPS|destructiveHint|isOperationBound" packages/shared/src/mcp/tool-factory.test.ts docs/deployment/binary-style-deployment.md packages/shared/src/mcp/tool-factory.ts` passed.
- `pnpm --filter @repo/shared test -- src/mcp/tool-factory.test.ts` passed with 6 tests.
- `pnpm --filter @repo/shared typecheck` passed.
- `git diff --check -- packages/shared/src/mcp/tool-factory.test.ts docs/deployment/binary-style-deployment.md` passed with line-ending warnings only.

## Deviations
- None.
