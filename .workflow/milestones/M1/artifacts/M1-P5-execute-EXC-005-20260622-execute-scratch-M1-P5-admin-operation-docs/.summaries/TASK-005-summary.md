# TASK-005 Summary

## Result
completed

## Files modified
- `apps/web/src/app/[locale]/(dashboard)/dashboard/admin/status/page.tsx`
- `apps/web/src/app/[locale]/(dashboard)/dashboard/admin/status/update-status-card.tsx`

## Implementation notes
- Added `UpdateStatusCard` to the existing admin status page without adding a new sidebar entry.
- The card calls `getAdminUpdateStatusAction`, `checkAdminUpdateAction`, and `applyAdminUpdateAction` through `useAction`.
- The UI shows updater enabled/configured/current version, disabledReason, check result, explicit `confirmVersion` confirmation, and apply result fields including `rollback` and healthcheck status.
- The destructive apply panel is rendered only when `canAccessAdminArea(role)` is true; `observer_admin` keeps the read-only global status page without update controls.
- The risk copy explicitly states that DB migration does not automatically rollback.
- The component displays only redacted summaries and does not include secret env token names checked by the convergence guard.

## Verification
- `rg -n "UpdateStatusCard|checkAdminUpdateAction|applyAdminUpdateAction|getAdminUpdateStatusAction|confirmVersion|rollback|DB migration" ...` passed and found required UI/action markers.
- Secret-token scan for `DATABASE_URL|BETTER_AUTH_SECRET|CHATGPT_WEB_PROXY_SECRET` in `update-status-card.tsx` passed.
- `pnpm --filter @repo/web typecheck` passed.
- `pnpm --filter @repo/web lint` exited 0. Existing repository warnings remain non-blocking.
- `git diff --check -- "apps/web/src/app/[locale]/(dashboard)/dashboard/admin/status/page.tsx" "apps/web/src/app/[locale]/(dashboard)/dashboard/admin/status/update-status-card.tsx"` passed.

## Deviations
- None.
