---
title: "Review Standards"
readMode: optional
priority: medium
category: review
keywords:
  - review
  - security
  - risk
  - checklist
  - regression
---

# Review Standards

## Checklist

- 是否遵守 UOL-first：新功能是否先注册 operation，并声明权限、能力位、副作用、破坏性和幂等。
- 是否保护单一图像管线：图片生成、编辑、Chat、Agent、外部 API 是否仍汇入 `runImageGenerationForUser`。
- 是否保护财务账本：扣费、退款、发放、订阅和积分包是否以 `credits_transaction` 与 `credits_batch` 为准。
- 是否有权限边界：用户资源访问是否校验归属，管理操作是否走 admin 权限和审计。
- 是否有输入校验：外部输入、Webhook、DB 结果和第三方响应是否经 Zod 或等价收窄。
- 是否有回归测试：核心逻辑、边界、失败和重复请求是否覆盖。
- 是否同步文档：`AGENTS.md` 与 `CLAUDE.md` 若有改动必须逐字一致。

## Security Focus

- 防 SQL 注入、XSS、CSRF、SSRF、命令注入、路径穿越和 IDOR。
- 向第三方或上游转发请求时不得携带客户端 `Authorization` 或 Cookie。
- Secret 不进入仓库、文档、日志、注释或测试 fixture。

## Entries

- 2026-06-21：初始化时将 AGENTS/CLAUDE 的安全和评审约束转写入 Maestro specs，后续评审优先加载本文件与 architecture constraints。


<spec-entry category="review" keywords="binary-style,secrets,manifest,systemd,review" date="2026-06-21" title="Binary-style release artifact 禁入 secrets" description="Binary-style 契约与示例文件不得携带真实密钥" source="execute:.workflow/scratch/20260621-plan-M1-P1-deployment-contract-artifact-spec">

### Binary-style release artifact 禁入 secrets

Binary-style manifest example、systemd 模板和验证脚本必须避免写入真实 secrets、token、password、DATABASE_URL 或 BETTER_AUTH_SECRET。M1-P1 的 verify-binary-contract 只检查新增契约文件和示例文件，不读取运行时 env。

</spec-entry>