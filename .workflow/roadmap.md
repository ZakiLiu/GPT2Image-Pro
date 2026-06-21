# GPT2Image-Pro Roadmap：Binary-Style 在线更新

## Roadmap Decisions

| # | Decision | Choice | Source |
|---|----------|--------|--------|
| 1 | 当前路线图范围 | 只规划 item 1：类似 kiro.rs 的在线更新能力，服务器以 binary-style release artifact 部署 | user |
| 2 | 明确不进入当前实现 | item 2-6 只列入 backlog，不拆 phase、不排实现任务 | user |
| 3 | 分解策略 | Progressive，先建立本地可验证的 release/update 闭环，再暴露后台入口 | Wave 1 findings |
| 4 | 部署模式定位 | Binary-style 是 Docker Compose 之外的新增部署模式，不替换现有 GHCR 镜像与 compose 发布 | README、docker-compose.yml、docker-release.yml |
| 5 | 产物形态 | 以 Next standalone runtime、静态资源、迁移执行资产、Go sidecar binary、脚本与 manifest 组成可校验 bundle，不承诺单文件 binary | Dockerfile.web、Wave 1 risk |
| 6 | 首个目标平台 | 首版只面向 Linux x64 单实例 systemd 部署，后续再扩展平台矩阵 | Wave 1 risk |
| 7 | 安全顺序 | updater CLI / local script 稳定后，才允许接入 UOL/admin operation 与后台 UI | architecture specs、Wave 1 risk |

## Scope

### In Current Scope

- 设计并实现 GPT2Image-Pro 的 binary-style release artifact：用于在服务器上以版本化目录、`current` symlink、systemd 服务和共享数据目录运行 Web 应用与 ChatGPT Web sidecar。
- 扩展 release 流程，在 tag 发布时附加 bundle、manifest 与 SHA256 checksum。
- 实现服务器本地 updater CLI / script：下载、校验、解包、加锁、备份、迁移、切换、重启、健康检查和失败回滚。
- 在本地 updater 验证后，提供管理员可见的检查更新、执行更新和查看状态入口。
- 保持现有 Docker Compose 部署继续可用，且不改变默认推荐路径。

### Backlog / Out of Current Scope

以下条目只登记为 backlog，本路线图不规划实现 phase，也不产生当前 milestone 的交付任务：

| Item | Backlog Capability | Current Scope Decision |
|------|--------------------|------------------------|
| 2 | Sub2API 非数据库接口 | Out of scope |
| 3 | Codex 登录接口 | Out of scope |
| 4 | Agent 分支能力 | Out of scope |
| 5 | Agent 批量图片工具 | Out of scope |
| 6 | PSD 生成接口 | Out of scope |

## Milestone > Phase Hierarchy

### Milestone M1：Binary-Style Online Update

目标：让 GPT2Image-Pro 可以像 kiro.rs 式发布一样，通过 GitHub Release 的版本化 binary-style bundle 完成服务器在线更新，同时保留 Docker Compose 发布链路。

#### Phase 1：部署契约与产物规范

- Goal：定义 binary-style 部署的目录布局、进程模型、manifest schema、校验策略与回滚边界。
- Depends on：无。
- Planned outputs：
  - `releases/<version>/`、`current` symlink、`shared/storage`、`shared/.gpt2image`、env 文件与日志目录约定。
  - manifest 字段：version、commit、platform、artifact URL、artifact sha256、minimum supported version、migration mode、services、healthcheck。
  - systemd 单元草案：Web service 与 ChatGPT Web proxy service 分开管理。
  - 明确 bundle 不包含 secrets，运行时只读取服务器现有 env。
- Exit criteria：部署契约被文档化，能解释安装、更新、回滚和与 Docker Compose 的差异。

#### Phase 2：Release Bundle 与 CI 产物

- Goal：在现有 Docker release 之外，生成 Linux x64 binary-style bundle、manifest 与 checksum。
- Depends on：Phase 1。
- Planned outputs：
  - Web bundle：`apps/web/.next/standalone`、`apps/web/.next/static`、`apps/web/public`、必要 traced native assets 与启动脚本。
  - Migrator bundle：可在目标机执行的数据库迁移入口与所需 package/runtime 资产。
  - Sidecar bundle：`services/chatgpt-web-proxy` 的 Linux x64 binary。
  - Release assets：`.tar.gz`、`.zip`、`.sha256`、`manifest.json`。
  - CI release workflow 更新：tag 触发时同时保留 GHCR 镜像、compose 包和 binary-style 包。
- Exit criteria：从 release asset 解包后，不依赖仓库源码即可启动 Web 与 sidecar 的 dry-run 检查。

#### Phase 3：本地 Updater CLI / Script Core

- Goal：先完成可在服务器手动执行的安全更新器，不先做后台触发。
- Depends on：Phase 2。
- Planned outputs：
  - `check`：读取当前版本、请求 release manifest、判断可升级版本。
  - `download`：下载 artifact 与 checksum，支持断点失败清理。
  - `verify`：校验 SHA256、manifest platform、version 和 artifact 文件名。
  - `stage`：在 staging 目录解包，检查必需文件、权限和 env 依赖。
  - `lock`：防止并发执行更新。
  - `dry-run`：不切换线上版本，只验证下载、校验、解包与环境检查。
- Exit criteria：checksum 错误、平台不匹配、重复执行和缺失 env 均能失败退出，且不影响当前运行版本。

#### Phase 4：迁移、切换、重启与回滚闭环

- Goal：把 updater 从安全预检推进到真实更新执行，并覆盖失败回滚。
- Depends on：Phase 3。
- Planned outputs：
  - Preflight：磁盘空间、当前服务状态、数据库连接、版本兼容性、备份路径检查。
  - Migration step：在切换前执行幂等迁移，记录迁移日志，失败则停止切换。
  - Switch step：将 `current` symlink 原子切换到新 release。
  - Restart step：只重启 GPT2Image-Pro 相关 systemd services，避免影响同机其他服务。
  - Healthcheck：验证 Web HTTP、sidecar 端口、数据库连接和基础管理员入口。
  - Rollback：应用或 sidecar 健康检查失败时切回上一版并重启；数据库迁移不可逆风险必须在日志中标明。
- Exit criteria：可在测试机完成从 N 到 N+1 的更新演练，并能通过人为制造启动失败验证应用层 rollback。

#### Phase 5：Admin Operation、后台入口与文档收口

- Goal：在本地 updater 已验证后，接入管理员在线更新入口，并完成用户可执行文档。
- Depends on：Phase 4。
- Planned outputs：
  - UOL operation：`update.check`、`update.status`、`update.apply`，声明 admin 权限、破坏性、副作用、锁、审计和输入 schema。
  - Thin transport：server action 或 api route 只调用 UOL gateway，不直接执行底层更新逻辑。
  - Admin UI：展示当前版本、可用版本、校验状态、执行进度、最近日志和 rollback 结果。
  - Docs：README 部署方式补充、CI/CD release 说明、systemd 安装与回滚 runbook。
  - Guardrails：默认关闭远程执行能力，只有明确配置 updater path 与 admin 权限后才启用。
- Exit criteria：管理员能从后台安全查看更新状态；执行更新路径经过权限、审计、锁和失败提示保护。

## Progress Table

| Milestone | Phase | Status | Progress | Blocking Dependencies | Evidence |
|-----------|-------|--------|----------|-----------------------|----------|
| M1 | Phase 1：部署契约与产物规范 | Planned | 0% | 无 | Roadmap only |
| M1 | Phase 2：Release Bundle 与 CI 产物 | Planned | 0% | Phase 1 | docker-release.yml 现有 Docker release 可扩展 |
| M1 | Phase 3：本地 Updater CLI / Script Core | Planned | 0% | Phase 2 | Wave 1 risk 要求先本地验证 |
| M1 | Phase 4：迁移、切换、重启与回滚闭环 | Planned | 0% | Phase 3 | Wave 1 dependency 指出 migration 与 rollback 是关键路径 |
| M1 | Phase 5：Admin Operation、后台入口与文档收口 | Planned | 0% | Phase 4 | UOL-first 约束要求后台入口薄适配 |

## Requirements Mapping

每条 Active project requirement 在本表中只出现一次，并统一映射到 Milestone M1。

| Requirement ID | Active Requirement | Roadmap Mapping |
|----------------|--------------------|-----------------|
| AR-1 | 按统一接口层 UOL / Operation Registry 继续收敛功能入口，让功能先成为可被 agent 调用的 operation，再按需暴露到 server-action、api-route、cron 或 webhook。 | M1，Phase 5 |
| AR-2 | 维护单一图像生成管线 `runImageGenerationForUser`，确保页面、Chat/Agent、外部 v1 API 与 mixed 分组调度共享一致扣费、审核、存储与错误语义。 | M1，全程保护，更新能力不触碰生成业务路径 |
| AR-3 | 保持套餐能力矩阵、系统设置示例与后台配置面板同步，新增能力位必须同步测试与文档。 | M1，Phase 5，若新增 updater 管理开关或能力位则同步配置、测试与文档 |
| AR-4 | 在涉及 credits、storage、moderation、payment、subscription、auth、API Key 的改动中补齐幂等、权限、输入校验和 DB-free 单测。 | M1，Phase 5，管理员更新入口涉及 auth 与权限时补齐校验和单测 |
| AR-5 | 继续完善部署、CI/CD、质量门和 Maestro 工作流资料，使变更可追溯、可验证、可解释。 | M1，Phase 1-5 |

## Success Criteria

- Tag release 同时产出 GHCR 镜像、compose 包和 binary-style release assets，且各资产版本一致。
- Linux x64 服务器可以不拉取源码、不执行 `git pull`，仅通过 release bundle 安装或更新服务。
- Updater 在下载、校验、staging、切换、重启、健康检查任一步失败时给出可定位错误，并保持当前版本可继续运行。
- 应用层启动失败可自动 rollback 到上一版；数据库迁移风险被预检、日志和 runbook 明确约束。
- 现有 Docker Compose 推荐部署方式不被移除，升级仍可通过 `docker compose pull && docker compose up -d` 完成。
- 后台在线更新入口只在本地 updater 稳定后开放，并受 admin 权限、审计、锁和显式配置保护。
- release artifact 不包含 secrets，不向日志、文档或 manifest 写入密钥、令牌或口令。

## Tests and Docs Gates

| Gate Type | Required Gate | Applies To |
|-----------|---------------|------------|
| Typecheck | `pnpm turbo typecheck` | Phase 2-5 |
| Lint | `pnpm turbo lint` | Phase 2-5 |
| Unit tests | `pnpm turbo test` | Phase 3-5 |
| Web build | `pnpm build:web` 或等价 Turbo build | Phase 2 |
| Sidecar build | `go test ./...` 与 Linux x64 build | Phase 2 |
| Packaging tests | 验证 bundle 文件清单、manifest schema、SHA256 mismatch、platform mismatch | Phase 2-3 |
| Updater tests | dry-run、并发锁、断点失败清理、staging 缺文件、权限不足、rollback 演练 | Phase 3-4 |
| Security tests | admin 权限、输入 schema、命令参数白名单、路径穿越防护、日志脱敏 | Phase 5 |
| Docs mirror | 如修改 `AGENTS.md` 或 `CLAUDE.md`，必须保持逐字一致 | Any phase |
| Deployment docs | README、docs/CI-CD.md、binary install runbook、rollback runbook | Phase 1、Phase 5 |

## Risks

| Risk | Impact | Mitigation | Phase |
|------|--------|------------|-------|
| Next standalone 不是真正单文件 binary | 产物结构复杂，容易漏静态资源或 native assets | 明确 binary-style 定义，使用 manifest 和文件清单测试 | Phase 1-2 |
| 数据库迁移不可自动回滚 | 更新失败可能无法完全回到旧 schema | 迁移前备份，迁移失败不切换，runbook 标明不可逆边界 | Phase 4 |
| secrets 泄露 | release asset 或日志暴露生产密钥 | bundle 不打包 env，日志脱敏，manifest 只放非敏感元数据 | Phase 1-5 |
| 管理后台远程触发过早 | 错误点击或越权导致生产更新 | 先做本地 updater，后台入口默认关闭并走 admin/UOL/审计/锁 | Phase 3-5 |
| 同机其他服务被影响 | systemd 或脚本误重启无关服务 | 服务名白名单，只管理 GPT2Image-Pro web/proxy/migrator 相关单元 | Phase 4 |
| 多实例和 process-local 状态 | 在线更新期间异步任务、缓存或队列状态不一致 | 首版限定单实例，后续多实例升级另开 milestone | Phase 1 |
| Release 供应链完整性不足 | artifact 被篡改或版本不一致 | SHA256 必验，后续可追加签名；manifest version 与 tag 强校验 | Phase 2-3 |
| Docker 与 binary-style 配置漂移 | 两种部署方式行为不一致 | 共享 env 约定、健康检查与 release 版本号，文档明确差异 | Phase 1-5 |

## Next Step

从 Phase 1 开始，先写部署契约与产物清单，再动 CI 和 updater。不要直接从后台 UI 或远程执行入口开工。
