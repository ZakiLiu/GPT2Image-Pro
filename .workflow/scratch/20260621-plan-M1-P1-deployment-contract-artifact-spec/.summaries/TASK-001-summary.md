# TASK-001 执行摘要：新增 binary-style 部署契约文档

## 实际修改文件

- `docs/deployment/binary-style-deployment.md`：新增 binary-style 部署契约文档。
- `.workflow/scratch/20260621-plan-M1-P1-deployment-contract-artifact-spec/.summaries/TASK-001-summary.md`：新增本任务执行摘要。
- `.workflow/.csv-wave/20260621-execute-scratch-M1-P1-deployment-contract-artifact-spec/discoveries.ndjson`：追加 implementation_note。

## Convergence criteria 验证

1. `Test-Path docs/deployment/binary-style-deployment.md`
   - 结果：pass
   - 证据：命令返回 `True`。

2. `rg -n "releases/<version>|current symlink|shared/storage|shared/.gpt2image|/etc/gpt2image/gpt2image.env|/var/log/gpt2image" docs/deployment/binary-style-deployment.md`
   - 结果：pass
   - 证据：匹配到 `releases/<version>/`、`current symlink`、`shared/storage`、`shared/.gpt2image`、`/etc/gpt2image/gpt2image.env`、`/var/log/gpt2image/`，其中关键命中包括第 56、62、64、74、98 行。

3. `rg -n "Docker Compose|不替换|Linux x64|单实例|systemd" docs/deployment/binary-style-deployment.md`
   - 结果：pass
   - 证据：匹配到 Docker Compose 差异、不替换声明、Linux x64、单实例、systemd，关键命中包括第 3、22、171、173、185 行。

4. `rg -n "secrets|\.env|storage|\.gpt2image" docs/deployment/binary-style-deployment.md`
   - 结果：pass
   - 证据：匹配到 secrets、`.env`、storage、`.gpt2image` 的边界说明，关键命中包括第 11、64、72、91、92 行。

5. `git diff --check -- docs/deployment/binary-style-deployment.md`
   - 结果：pass
   - 证据：命令退出码为 0，未报告 whitespace error。

## 偏离计划及原因

无。
## Orchestrator Verification

- [PASS] `Test-Path docs/deployment/binary-style-deployment.md`
- [PASS] `rg -n "releases/<version>|current symlink|shared/storage|shared/.gpt2image|/etc/gpt2image/gpt2image.env|/var/log/gpt2image" docs/deployment/binary-style-deployment.md`
  - evidence: 47:  current -> releases/<version>/ | 56:必须使用 `releases/<version>/` 保存不可变版本目录。`current symlink` 指向当前运行版本，实际路径形如 `current -> releases/<version>/`。服务的 `WorkingDirectory` 应指向 `current` 下的具体 runtime 目录，而不是写死某个版本目录。 | 58:`shared/` 只保存跨版本运行态数据，release bundle 不得写入或覆盖这些目录。updater 解包新版本时只能写入新的 `releases/<version>/` 和临时 staging 目录，不能覆盖当前版本目录。 | 62:`shared/storage` 是 Web 应用的本地文件存储目录，对应 Docker Compose 中的 `app-storage` volume 和容器内 `/app/storage`。如果生产环境改用 S3/R2/MinIO，`shared/storage` 仍作为本地 fallback 或临时文件目录，不随
- [PASS] `rg -n "Docker Compose|不替换|Linux x64|单实例|systemd" docs/deployment/binary-style-deployment.md`
  - evidence: 3:本文定义 GPT2Image-Pro 新增 binary-style 部署模式的首版契约。它是 Phase 1 的设计文档，用于约束后续 release artifact、updater 和 systemd 单元实现；当前不表示 binary-style 产物或在线 updater 已经可用。现有 Docker Compose 发布链路继续保留，binary-style 不替换 Docker Compose，也不改变 README 中推荐的新部署路径。 | 12:- 为 Phase 2-4 的 bundle、manifest、checksum、updater CLI 和 systemd 单元提供可验证基线。 | 16:- 不在本阶段实现构建产物、下载器、updater、后台在线更新入口或 systemd unit 文件。 | 22:首版只支持 Linux x64 单实例部署，使用 systemd 管理 GPT2Image-Pro 相关进程。目标机器默认已有： | 29:多实例、蓝绿流量切换和跨平台产物后续另行设计；首版 updater 只管理本机单实例 systemd 服务。 | 
- [PASS] `rg -n "secrets|\.env|storage|\.gpt2image" docs/deployment/binary-style-deployment.md`
  - evidence: 11:- 约定 release bundle 不携带 secrets、`.env`、storage 和 `.gpt2image` 运行态数据。 | 18:- 不改变 Web 生图、credits、storage、moderation、payment 或 API 路径的业务语义。 | 49:    storage/ | 50:    .gpt2image/ | 62:`shared/storage` 是 Web 应用的本地文件存储目录，对应 Docker Compose 中的 `app-storage` volume 和容器内 `/app/storage`。如果生产环境改用 S3/R2/MinIO，`shared/storage` 仍作为本地 fallback 或临时文件目录，不随 release 切换。 | 64:`shared/.gpt2image` 保存启动时生成的本地运行态文件，例如 `super-admin-credentials.txt`。它对应 Docker Compose 中的 `app-bootstrap` volume 和容器内 `/app/.gpt2image`。该
- [PASS] `git diff --check -- docs/deployment/binary-style-deployment.md`
