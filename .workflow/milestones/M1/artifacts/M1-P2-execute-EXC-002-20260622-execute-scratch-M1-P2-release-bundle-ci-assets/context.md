# M1-P2 Execution Report

- Plan: .workflow/scratch/20260622-plan-M1-P2-release-bundle-ci-assets
- Session: .workflow/.csv-wave/20260622-execute-scratch-M1-P2-release-bundle-ci-assets
- Status: completed
- Completed tasks: 6 / 6
- Blocked tasks: 0
- Auto commit: false

## Wave results

| Wave | Task | Status | Files | Tests |
|---|---|---|---|---|
| 1 | TASK-001 | completed | scripts/build-binary-release-bundle.mjs; package.json | true |
| 2 | TASK-002 | completed | scripts/verify-binary-release-bundle.mjs; package.json | true |
| 3 | TASK-003 | completed | scripts/build-binary-release-bundle.mjs; scripts/verify-binary-release-bundle.mjs; docs/deployment/binary-style-deployment.md | true |
| 4 | TASK-004 | completed | .github/workflows/docker-release.yml | true |
| 5 | TASK-005 | completed | README.md; docs/CI-CD.md; docs/deployment/binary-style-deployment.md | true |
| 6 | TASK-006 | completed | scripts/build-binary-release-bundle.mjs; scripts/verify-binary-release-bundle.mjs | true |

## Verification evidence

- pnpm install --frozen-lockfile passed under Node 22.22.2. Node 24.4.1 hit a local heap error during install, so verification used the project/CI Node 22 line.
- pnpm verify:binary-contract passed.
- node scripts/verify-binary-release-bundle.mjs --self-test passed.
- pnpm build:web passed with the same build-time placeholder env used by docker-release.yml.
- go test ./... passed with Go 1.24.13 downloaded to a temporary local toolchain.
- GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build produced dist/binary-style/smoke/chatgpt-web-proxy.
- pnpm build:binary-bundle smoke passed for v0.0.0-alpha.0.
- pnpm verify:binary-bundle smoke passed.
- sha256sum -c passed for tar.gz and zip checksum files.
- tar -tzf and unzip -l confirmed Web standalone/static/public, migrator, bin/chatgpt-web-proxy, manifest.json and SHA256SUMS.
- tar grep_absent confirmed no top-level .env, storage, .gpt2image, secrets or logs paths.
- git diff --check passed for all M1-P2 source/doc/workflow files.

## Discoveries

- Legal Next route paths such as api/storage must not be treated as runtime storage directories; denylist now only blocks root-level runtime directories and .next/cache fragments.
- Detached .sha256 files need repository-relative artifact paths to satisfy the planned root-level sha256sum -c smoke command.

## Next steps

- Run code review / quality gate before committing.
- Keep generated dist/binary-style artifacts out of git.
