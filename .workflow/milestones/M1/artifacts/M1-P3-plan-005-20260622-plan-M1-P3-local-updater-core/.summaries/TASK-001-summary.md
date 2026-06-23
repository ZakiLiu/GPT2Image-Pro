# TASK-001 summary

## Files actually modified

- `scripts/binary-style-release-lib.mjs`：新增 binary-style release 校验 helper 模块，导出 manifest、artifact、必需路径、SHA256SUMS 和通用断言/路径 helper。
- `scripts/verify-binary-release-bundle.mjs`：改为从 `./binary-style-release-lib.mjs` import 通用 helper，保留 CLI 参数解析、输出文本、self-test fixture 与 `main().catch`。
- `.workflow/.csv-wave/20260622-execute-scratch-M1-P3-local-updater-core/discoveries.ndjson`：追加 1 条 `code_pattern` 发现。
- `.workflow/scratch/20260622-plan-M1-P3-local-updater-core/.summaries/TASK-001-summary.md`：本任务执行摘要。

## Verification evidence

- PASS `node -e "import('./scripts/binary-style-release-lib.mjs').then((m)=>{ for (const k of ['sha256File','verifyManifest','verifyArtifact','verifyRequiredPaths','verifySha256Sums','verifyBundle','assertObject','pathExists','listFiles']) { if (typeof m[k] !== 'function') throw new Error(k); } })"`
  - 证据：exit code 0，无错误输出。
- PASS `node scripts/verify-binary-release-bundle.mjs --self-test`
  - 证据：exit code 0，输出 `Binary release bundle verifier self-test passed.`。
- PASS `rg -n 'from "./binary-style-release-lib.mjs"|from ''./binary-style-release-lib.mjs''' scripts/verify-binary-release-bundle.mjs`
  - 证据：exit code 0，输出 `17:} from "./binary-style-release-lib.mjs";`。
- PASS `rg -n 'export async function sha256File|export function verifyManifest|export async function verifyBundle' scripts/binary-style-release-lib.mjs`
  - 证据：exit code 0，输出第 149、199、308 行分别命中 `sha256File`、`verifyManifest`、`verifyBundle`。
- PASS `git diff --check -- scripts/binary-style-release-lib.mjs scripts/verify-binary-release-bundle.mjs`
  - 证据：exit code 0；PowerShell 输出 Git 的 CRLF 工作区提示，但无 whitespace error。

## Deviations from plan

- 无代码语义偏离。`verify-binary-release-bundle.mjs` 只保留 CLI/self-test，校验语义迁入 lib 后由 self-test 覆盖。
- 执行命令时将 `rg` 的正则改成 PowerShell 兼容单引号写法；正则内容与收敛标准等价。首次把全部收敛命令按原 bash 风格放入 PowerShell 多行执行时发生解析错误，未反映代码问题，已逐条按等价命令重跑并通过。
