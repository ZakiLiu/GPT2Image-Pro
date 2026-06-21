# Project: GPT2Image-Pro

## What This Is

GPT2Image-Pro 是面向生图业务的 SaaS 平台，把 ChatGPT Web、Codex/Responses、OpenAI 兼容 API、Sub2API 等账号能力统一接入账号池，并转换为可运营、可计费、可分套餐交付的 Web 与 API 服务。

项目采用 Turborepo monorepo，主应用在 `apps/web`，共享业务能力在 `packages/shared`，数据库 schema 与连接在 `packages/database`，UI 组件在 `packages/ui`。

## Core Value

把多来源图像生成能力稳定、可控、可计费地交付给页面用户与外部 API 用户；任何改动都不能破坏单一图像管线、积分流水、套餐能力矩阵与账号池调度的可信边界。

## Requirements

### Validated

<!-- Shipped and confirmed valuable. -->

- 已有页面创作能力：文生图、图生图、逐行批量、瀑布流、Chat 生图、Agent 自动迭代、图库与历史记录。
- 已有 OpenAI 兼容 API：`/v1/chat/completions`、`/v1/images/generations`、`/v1/images/edits`、`/v1/responses`、`/v1/agents/images`、额度与模型查询。
- 已有账号池与调度：Web 账号、Codex/Responses 账号、外接 API、mixed 分组、优先级、权重、并发、排队、冷却与错误状态。
- 已有计费与套餐：能力矩阵、订阅、按量积分包、API Key 独立额度、尺寸价格曲线、Chat/Agent 轮次价格与积分流水。

### Active

<!-- Current scope being built toward. These are hypotheses until shipped. -->

- [ ] 按统一接口层 UOL / Operation Registry 继续收敛功能入口，让功能先成为可被 agent 调用的 operation，再按需暴露到 server-action、api-route、cron 或 webhook。
- [ ] 维护单一图像生成管线 `runImageGenerationForUser`，确保页面、Chat/Agent、外部 v1 API 与 mixed 分组调度共享一致扣费、审核、存储与错误语义。
- [ ] 保持套餐能力矩阵、系统设置示例与后台配置面板同步，新增能力位必须同步测试与文档。
- [ ] 在涉及 credits、storage、moderation、payment、subscription、auth、API Key 的改动中补齐幂等、权限、输入校验和 DB-free 单测。
- [ ] 继续完善部署、CI/CD、质量门和 Maestro 工作流资料，使变更可追溯、可验证、可解释。

### Out of Scope

<!-- Explicit boundaries. Include reasoning to prevent re-adding. -->

- 直接在 `main` 分支开发或推送 — 项目约定开发在 `dev`，`main` 仅在用户明确要求时用于生产。
- 绕过 `protectedAction`、`adminAction` 或 UOL 网关直接暴露敏感能力 — 会造成权限、审计和幂等逻辑分散。
- 用 `drizzle-kit generate` 生成迁移 — 项目要求手写幂等 SQL 并登记 journal，避免快照漂移进入交互模式。
- 把密钥、令牌、口令写入仓库、文档、注释或日志 — 机密只能在 `.env.local` 与部署环境中保存。

## Context

该项目是 TypeScript strict 的 Turborepo monorepo，使用 pnpm、Next.js 16 App Router、React 19、Drizzle ORM、PostgreSQL、Better Auth、Zod、next-safe-action、Creem、next-intl、Fumadocs MDX、Biome 和 Vitest。部署目标为 Docker Compose + Nginx + Certbot。

项目文档入口包括 `README.md`、`AGENTS.md` / `CLAUDE.md`、`docs/CI-CD.md`、`docs/MEMORY.md`、`docs/TODO.md` 与 `docs/plan/`。当前 Maestro 初始化是在已有代码库上补齐 `.workflow/` 工作流结构，保留既有 `.workflow/wiki-index.json`。

## Constraints

- **Language**: 对话、注释和提交信息使用简体中文；代码标识符保持英文；任何输出、代码、注释、提交信息和文档都不使用 emoji。
- **Type Safety**: TypeScript strict；禁止 `any`，必要时使用 `unknown` 并类型收窄。
- **Formatting**: Biome 统一双引号、分号、2 空格和 80 字符行宽；提交前 lint 不得有 error。
- **Architecture**: 新功能先注册为 `packages/shared/src/uol/` 下的 `defineOperation()` operation，传输层只做薄适配。
- **Finance**: 财务真相在 `credits_transaction`；扣费和发放必须有幂等键，并考虑并发与重复请求。
- **Image Pipeline**: 5 个 v1 handler 最终必须汇入 `runImageGenerationForUser`，不可绕开单一管线。
- **Migrations**: 迁移使用手写幂等 SQL 与 `meta/_journal.json`，不用 `drizzle-kit generate`。
- **Security**: 外部输入必须校验；服务端动作走 `protectedAction` / `adminAction`；向上游转发不得携带客户端凭据。
- **Git**: 只 stage 当前任务产物，使用 `git add <specific-files>`；遇到未提交冲突必须停止报告。

## Tech Stack

- **Language**: TypeScript strict
- **Framework**: Next.js 16 App Router, React 19, Turborepo, pnpm
- **Database**: PostgreSQL with Drizzle ORM
- **Auth**: Better Auth
- **Validation / Actions**: Zod, next-safe-action
- **Payment**: Creem, internal credits ledger
- **i18n / Docs**: next-intl, Fumadocs MDX
- **UI**: Shadcn/UI via `packages/ui`
- **Quality**: Biome, Vitest, Turbo tasks
- **Deployment**: Docker Compose, Nginx, Certbot, DigitalOcean

## Key Decisions

<!-- Decisions that constrain future work. Add throughout project lifecycle. -->

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| 以 UOL / Operation Registry 作为后续功能统一入口 | 避免 server-action、api-route、cron、webhook 和 agent 入口重复权限、审计与幂等逻辑 | Accepted |
| 保持 `runImageGenerationForUser` 作为单一图像管线 | 单点保证扣费、审核、存储、调度和错误语义一致 | Accepted |
| 以 `credits_transaction` 作为财务真相 | `generation` 行只用于历史与画廊展示，不能承载财务一致性 | Accepted |
| 手写幂等 Drizzle SQL 迁移 | 避免 `drizzle-kit generate` 快照漂移与交互模式 | Accepted |
| `AGENTS.md` 与 `CLAUDE.md` 必须逐字一致 | CI `docs-mirror` 强制，避免协作 Agent 规则漂移 | Accepted |

## Stakeholders

- 平台管理员与运营人员
- 页面生图用户
- 外部 API 用户与集成方
- 维护 GPT2Image-Pro 的开发者和协作 Agent

---
*Last updated: 2026-06-21 after initialization*
