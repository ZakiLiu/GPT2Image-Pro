# TASK-004 执行摘要：补充 README 与 CI/CD 文档入口

## 实际修改文件

- `README.md`：在生产部署章节新增 `binary-style` 契约预留入口，并在发布章节标注后续 Phase 2 才接入 binary-style release assets。
- `docs/CI-CD.md`：补充 `docker-release.yml` 当前产物边界，明确现阶段只发布 GHCR 镜像与 compose 包，binary-style bundle、manifest、checksum assets 后续 M1-P2 接入。

## Convergence criteria 验证

1. `rg -n "binary-style|docs/deployment/binary-style-deployment.md|Docker Compose（推荐）" README.md`
   - 结果：pass。
   - 证据：匹配到 `Docker Compose（推荐）`、`binary-style 契约预留（后续）`、`docs/deployment/binary-style-deployment.md`，关键行包括 `README.md:158`、`README.md:168`、`README.md:170`、`README.md:181`、`README.md:310`。

2. `rg -n "binary-style|manifest|checksum|compose 包|GHCR" docs/CI-CD.md`
   - 结果：pass。
   - 证据：匹配到 `GHCR`、`compose 包`、`binary-style`、`manifest`、`checksum`，关键行包括 `docs/CI-CD.md:11`、`docs/CI-CD.md:36`、`docs/CI-CD.md:38`、`docs/CI-CD.md:39`。

3. `rg -n "binary-style.*已发布|在线更新.*已可用" README.md docs/CI-CD.md docs/deployment/binary-style-deployment.md`
   - 结果：pass。
   - 证据：命令退出码为 `1`，无匹配；未出现会让用户误解为 binary-style 已发布或在线更新已可用的表述。

4. `git diff --check -- README.md docs/CI-CD.md docs/deployment/binary-style-deployment.md`
   - 结果：pass。
   - 证据：命令退出码为 `0`；无 whitespace error。Git 仅提示 Windows 工作副本行尾替换 warning，不影响 diff check 结果。

## 偏离计划及原因

无。

## Orchestrator Verification

- [PASS] `rg -n "binary-style|docs/deployment/binary-style-deployment.md|Docker Compose（推荐）" README.md`
  - evidence: 158:| | **方式一：Docker Compose（推荐）** | **方式二：源码部署** |
 | 168:### binary-style 契约预留（后续） | 170:当前生产新部署仍以 **Docker Compose（推荐）** 为主。`docs/deployment/binary-style-deployment.md` 记录 binary-style 部署契约，用于约束后续 release assets、manifest、checksum、updater 和 systemd 单元；Phase 2 接入前，Release 仍只提供 GHCR 镜像与 compose 包，不提供可执行的 binary-style bundle。 | 181:### 方式一：Docker Compose（推荐）
 | 310:- binary-style release assets 会在后续 Phase 2 接入；当前只保留契约入口：`docs/deployment/binary-style-deployment.md`
- [PASS] `rg -n "binary-style|manifest|checksum|compose 包|GHCR" docs/CI-CD.md`
  - evidence: 11:| `.github/workflows/docker-release.yml` | push tag `v*.*.*`，手动 | 发布：构建并推送 3 个镜像到 GHCR + 起草 GitHub Release（compose 包；binary-style assets 后续接入） | | 36:- 构建 + 推送到 GHCR（`ghcr.io`）3 个镜像：`web`、`migrate`、`chatgpt-web-proxy`，tag 含语义 tag、`latest`、`sha-<sha>`。 | 38:- 当前 release 产物只包含 GHCR 镜像与 compose 包；compose 包由 `docker-compose.yml`、`docker-compose.build.yml`、`.env.docker.example` 和 `README.md` 组成。 | 39:- binary-style 仍处于契约阶段，入口为 `docs/deployment/binary-style-deployment.md`，manifest schema 为 `docs/de
- [PASS] `rg -n "binary-style.*已发布|在线更新.*已可用" README.md docs/CI-CD.md docs/deployment/binary-style-deployment.md`
- [PASS] `git diff --check -- README.md docs/CI-CD.md docs/deployment/binary-style-deployment.md`
  - evidence: warning: in the working copy of 'README.md', LF will be replaced by CRLF the next time Git touches it | warning: in the working copy of 'docs/CI-CD.md', LF will be replaced by CRLF the next time Git touches it
