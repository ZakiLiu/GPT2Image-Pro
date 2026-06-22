---
title: "Debug Notes"
readMode: optional
priority: medium
category: debug
keywords:
  - debug
  - pitfall
  - failure
  - workaround
  - command
---

# Debug Notes

## Known Pitfalls

- `maestro kg search <symbol> --code` 在当前本地 CLI 中不可用，会返回 `unknown option '--code'`；需要先用不带 `--code` 的 `maestro kg search` 或直接用源码搜索。
- 当前项目初始化前 MaestroGraph 未建立，`maestro kg search` 会提示 `MaestroGraph not initialized for this project. Run: maestro kg sync`。
- 独立 typecheck 前需要生成 Fumadocs `.source`，CI 使用 `pnpm --filter @repo/web exec fumadocs-mdx`。
- Drizzle 迁移不要用 `drizzle-kit generate`；手写幂等 SQL 并维护 journal。

## Entries

- 2026-06-21：初始化时 `maestro spec init` 成功，但 seed spec 内容为空壳，因此手动根据仓库配置、README、AGENTS、CI 和源码结构补齐首批约束。


<spec-entry category="debug" keywords="binary-style bundle denylist storage next-standalone" date="2026-06-22" title="M1-P2 bundle denylist root-level runtime paths" description="Next api/storage route must not trip runtime storage denylist" source="execute:.workflow/scratch/20260622-plan-M1-P2-release-bundle-ci-assets">

### M1-P2 bundle denylist root-level runtime paths

Artifact smoke 发现 Next standalone 会包含合法源码路由 apps/web/src/app/api/storage/...，如果按任意 path segment 禁入 storage 会误伤合法代码。bundle 敏感路径检查应只禁止顶层运行态目录（.env、storage、.gpt2image、secrets、logs）和明确缓存片段（.next/cache），同时继续禁止 .pem/.key。Evidence: scripts/build-binary-release-bundle.mjs, scripts/verify-binary-release-bundle.mjs, pnpm verify:binary-bundle smoke.

</spec-entry>

<spec-entry category="debug" keywords="binary-style sha256 release-assets smoke" date="2026-06-22" title="M1-P2 sha256 files use repo-relative artifact path" description="Detached sha256 files must work from repo root" source="execute:.workflow/scratch/20260622-plan-M1-P2-release-bundle-ci-assets">

### M1-P2 sha256 files use repo-relative artifact path

Artifact smoke 发现 .sha256 写 basename 时，从仓库根执行计划命令 sha256sum -c dist/.../*.sha256 会找不到 artifact。build-binary-release-bundle 应写入仓库相对 artifact 路径，确保文档、CI 和本地 smoke 命令一致。Evidence: sha256sum -c dist/binary-style/v0.0.0-alpha.0/*.sha256 OK.

</spec-entry>