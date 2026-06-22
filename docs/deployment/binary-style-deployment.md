# Binary-Style 部署契约

本文定义 GPT2Image-Pro 新增 binary-style 部署模式的首版契约。它约束 release artifact、manifest、checksum、updater 和 systemd 单元实现；M1-P2 起 GitHub Release 会附加 binary-style release assets，但当前仍不表示在线 updater、本地切换、后台 admin operation 或后台 UI 已经可用。现有 Docker Compose 发布链路继续保留，binary-style 不替换 Docker Compose，也不改变 README 中推荐的新部署路径。

## 目标与非目标

目标：

- 约定服务器上的版本化目录、共享运行态目录、env 文件、日志目录和服务边界。
- 约定安装、更新、回滚时的顺序，尤其是迁移必须先于 `current` 切换。
- 约定 release bundle 不携带 secrets、`.env`、storage 和 `.gpt2image` 运行态数据。
- 为 Phase 2-4 的 bundle、manifest、checksum、updater CLI 和 systemd 单元提供可验证基线。
- 说明 M1-P2 release assets 的命名、校验方式和 migrator bundle runtime 边界。

非目标：

- 不在 M1-P2 实现下载器、updater、本地切换、重启、回滚、后台在线更新入口或后台 UI。
- 不支持多实例滚动发布、Kubernetes、Windows、macOS 或 Docker 镜像替换。
- 不改变 Web 生图、credits、storage、moderation、payment 或 API 路径的业务语义。

## 首版目标平台

首版只支持 Linux x64 单实例部署，使用 systemd 管理 GPT2Image-Pro 相关进程。目标机器默认已有：

- PostgreSQL 数据库，既可以来自同机服务，也可以来自外部托管数据库。
- Nginx 或其他反向代理，用于 TLS 终止和公网入口。
- Node.js 运行时，版本需与 release bundle 的 Next standalone 构建要求一致。
- 可选的对象存储、Redis、Axiom、Sentry 等外部服务，缺失时沿用应用既有降级策略。

多实例、蓝绿流量切换和跨平台产物后续另行设计；首版 updater 只管理本机单实例 systemd 服务。

## 目录布局

约定安装根目录为 `/opt/gpt2image`。如果运维选择其他根目录，必须保持相同的相对布局。

```text
/opt/gpt2image/
  releases/
    <version>/
      apps/web/.next/standalone/
      apps/web/.next/static/
      apps/web/public/
      packages/database/
      services/chatgpt-web-proxy/chatgpt-web-proxy
      scripts/
      manifest.json
      SHA256SUMS
  current -> releases/<version>/
  shared/
    storage/
    .gpt2image/
    cache/
    staging/
    backups/
```

必须使用 `releases/<version>/` 保存不可变版本目录。`current symlink` 指向当前运行版本，实际路径形如 `current -> releases/<version>/`。服务的 `WorkingDirectory` 应指向 `current` 下的具体 runtime 目录，而不是写死某个版本目录。

`shared/` 只保存跨版本运行态数据，release bundle 不得写入或覆盖这些目录。updater 解包新版本时只能写入新的 `releases/<version>/` 和临时 staging 目录，不能覆盖当前版本目录。

## 共享数据目录

`shared/storage` 是 Web 应用的本地文件存储目录，对应 Docker Compose 中的 `app-storage` volume 和容器内 `/app/storage`。如果生产环境改用 S3/R2/MinIO，`shared/storage` 仍作为本地 fallback 或临时文件目录，不随 release 切换。

`shared/.gpt2image` 保存启动时生成的本地运行态文件，例如 `super-admin-credentials.txt`。它对应 Docker Compose 中的 `app-bootstrap` volume 和容器内 `/app/.gpt2image`。该目录可能包含初始超管凭据，必须按 secrets 处理，不进入 release bundle、不进入 manifest、不写入公开日志。

`shared/cache` 用于 Next/cache 或其他可清理缓存。缓存可以删除重建，但不应作为版本产物的一部分。

`shared/staging` 用于下载、校验和解包待上线 artifact。校验失败或更新中断时，updater 必须清理本次 staging 子目录，不影响 `current`。

`shared/backups` 用于保存更新前的 manifest、服务状态、必要配置快照和数据库备份引用。数据库备份文件是否落在该目录由部署环境决定，但日志中必须记录备份位置或外部备份任务 ID。

## env 文件与 secrets 边界

运行时环境变量统一从 `/etc/gpt2image/gpt2image.env` 读取。systemd 单元应通过 `EnvironmentFile=/etc/gpt2image/gpt2image.env` 引入配置；本文件由运维创建和维护，不由 release bundle 覆盖。

`/etc/gpt2image/gpt2image.env` 至少需要包含生产必填项：

```env
# DATABASE_URL is required; set it in your private env file.
# BETTER_AUTH_SECRET is required; generate it with openssl rand -base64 32.
BETTER_AUTH_URL=https://your-domain.example
NEXT_PUBLIC_APP_URL=https://your-domain.example
LOCAL_STORAGE_PATH=/opt/gpt2image/shared/storage
GPT2IMAGE_BOOTSTRAP_CREDENTIALS_PATH=/opt/gpt2image/shared/.gpt2image/super-admin-credentials.txt
CHATGPT_WEB_PROXY_URL=http://127.0.0.1:3021
CHATGPT_WEB_PROXY_SECRET=...
```

约束：

- bundle 不包含 secrets，不包含 `.env`、`.env.local`、`.env.production` 或任何真实环境变量文件。
- bundle 不包含 `storage` 目录，也不包含 `.gpt2image` 运行态数据。
- manifest 只记录非敏感元数据，例如 version、commit、platform、artifact sha256、service 名称和 healthcheck 路径。
- 日志、summary、manifest 和文档示例都只能使用占位值，不写真实密钥、令牌、Cookie 或数据库口令。

## 日志目录

日志根目录为 `/var/log/gpt2image/`。systemd journal 是主日志来源，文件日志只用于 updater 和迁移记录。

建议布局：

```text
/var/log/gpt2image/
  updater.log
  migrations.log
  web.log
  chatgpt-web-proxy.log
```

Web 与 ChatGPT Web proxy 的实时日志由 `journalctl -u <service>` 查看；updater 应把每次下载、校验、迁移、切换、重启、健康检查和回滚动作追加到 `/var/log/gpt2image/updater.log`。日志必须脱敏，不输出 secrets、`.env` 内容或完整连接串。

## 服务模型与进程边界

binary-style 部署拆成三个边界清晰的服务或任务：

| 边界 | 建议 systemd 单元 | 运行内容 | 生命周期 |
| --- | --- | --- | --- |
| Web | `gpt2image-web.service` | Next standalone：`node apps/web/server.js` | 常驻 |
| ChatGPT Web proxy | `gpt2image-chatgpt-web-proxy.service` | Go sidecar：`chatgpt-web-proxy` | 常驻 |
| Migrator | `gpt2image-migrate.service` 或 updater 内部步骤 | Drizzle migration 入口 | 更新时一次性 |

Web 负责页面、API、内置定时任务和主业务入口。它读取 `/etc/gpt2image/gpt2image.env`，使用 `LOCAL_STORAGE_PATH=/opt/gpt2image/shared/storage` 和 `GPT2IMAGE_BOOTSTRAP_CREDENTIALS_PATH=/opt/gpt2image/shared/.gpt2image/super-admin-credentials.txt`。

ChatGPT Web proxy 是独立 Go 进程，默认监听 `127.0.0.1:3021` 或 env 中指定地址。Web 通过 `CHATGPT_WEB_PROXY_URL` 和 `CHATGPT_WEB_PROXY_SECRET` 访问它。proxy 的重启和健康检查不得隐式重启 PostgreSQL、Nginx 或其他同机服务。

Migrator 是更新流程中的一次性步骤，不常驻。它必须在 `current symlink` 切换之前运行，并且针对待发布版本的迁移资产执行。迁移失败时停止更新，不切换 `current`，不重启 Web 到新版本。

## Migrator bundle runtime

M1-P2 的 release bundle 不要求目标机有仓库源码，也不需要 Git checkout 或在目标机执行 `git pull`。数据库迁移入口被收敛到 bundle 内的 `migrator/` 目录，包含以下运行边界：

```text
migrator/
  package.json
  pnpm-lock.yaml
  pnpm-workspace.yaml
  tsconfig.base.json
  RUNTIME.md
  packages/database/
    package.json
    drizzle.config.ts
    drizzle/
      meta/_journal.json
      *.sql
    src/
    tsconfig.json
```

目标机前置条件仍是 Node.js 22、Corepack/pnpm 和运行时 `DATABASE_URL`。release bundle 不写入真实连接串；迁移命令从 `/etc/gpt2image/gpt2image.env` 或调用环境读取配置。推荐命令形态如下：

```bash
cd /opt/gpt2image/releases/<version>/migrator
corepack enable
pnpm install --frozen-lockfile --prod=false
pnpm --dir packages/database db:migrate
```

该步骤是 `pre_switch` 一次性迁移，不常驻，也不承诺数据库自动回滚。M1-P2 只产出迁移运行资产；真正的下载、加锁、迁移执行、`current` 切换、重启、健康检查和回滚闭环留给后续 updater phase。

## 安装契约

首次安装按以下顺序执行：

1. 创建系统用户和目录：`/opt/gpt2image/releases`、`/opt/gpt2image/shared/storage`、`/opt/gpt2image/shared/.gpt2image`、`/opt/gpt2image/shared/cache`、`/var/log/gpt2image/`、`/etc/gpt2image/`。
2. 写入 `/etc/gpt2image/gpt2image.env`，权限限制为仅部署用户和 root 可读。
3. 下载 release artifact、manifest 和 checksum 到 staging。
4. 校验 artifact sha256、manifest version、platform 为 Linux x64，且 artifact 文件名与 version 匹配。
5. 解包到 `/opt/gpt2image/releases/<version>/`，确认必需文件存在。
6. 执行 migrator。首次安装也要在启动 Web 前完成数据库初始化或迁移。
7. 创建或更新 `current symlink` 指向 `releases/<version>/`。
8. 安装或 reload systemd 单元，只启动 `gpt2image-web.service` 和 `gpt2image-chatgpt-web-proxy.service`。
9. 执行健康检查：Web HTTP、proxy 端口、数据库连接和关键页面。

## 更新契约

更新必须是可中断、可审计、可回滚的本机操作。推荐顺序：

1. 加锁，防止并发 updater。
2. 读取当前 `current` 指向的版本和 manifest。
3. 下载新 artifact、manifest、checksum 到 `shared/staging/<version>/`。
4. 校验 sha256、version、minimum supported version、platform、service 清单和 healthcheck 定义。
5. 解包到新的 `releases/<version>/`，不修改旧 release。
6. 预检 `/etc/gpt2image/gpt2image.env`、磁盘空间、目录权限、数据库连接和现有 systemd 服务状态。
7. 运行 migrator。迁移必须先于 `current symlink` 切换；失败则停止，并保持旧版本继续运行。
8. 原子切换 `current` 到 `releases/<version>/`。
9. 只重启 GPT2Image-Pro 相关 systemd 服务：Web 和 ChatGPT Web proxy，不重启 PostgreSQL、Nginx 或其他应用。
10. 健康检查通过后记录成功；失败则进入回滚流程。

迁移可能不可逆，因此 updater 日志必须明确记录迁移开始、结束、失败和人工处理建议。若迁移已经成功但新应用启动失败，应用层可回滚到上一版；数据库 schema 是否可回滚取决于迁移设计，不能在文档中承诺自动数据库回滚。

## 回滚契约

回滚只改变应用版本指针和服务进程，不删除新 release 目录，便于排查。

1. 读取上一版 release 路径和 manifest。
2. 将 `current symlink` 原子切回上一版。
3. 重启 Web 和 ChatGPT Web proxy systemd 服务。
4. 运行健康检查并记录 `/var/log/gpt2image/updater.log`。
5. 保留失败版本目录、staging 日志和迁移日志，等待人工分析。

如果失败发生在迁移之前，回滚只需要恢复 `current` 和服务。若失败发生在迁移之后，回滚文档必须提示数据库迁移不可逆风险，并要求按备份或迁移 runbook 人工处理。

## Docker Compose 差异

binary-style 是新增部署模式，不替换 Docker Compose。

| 维度 | Docker Compose | binary-style |
| --- | --- | --- |
| 产物 | GHCR 镜像：web、migrate、chatgpt-web-proxy | release bundle：Next standalone、迁移资产、Go sidecar、manifest、checksum |
| 配置 | 默认读取项目根 `.env`，由 compose 注入容器 | 读取 `/etc/gpt2image/gpt2image.env`，不打包 `.env` |
| 数据 | `app-storage`、`app-bootstrap`、`postgres-data` volumes | `shared/storage`、`shared/.gpt2image`，数据库由外部服务或本机服务提供 |
| 编排 | compose `depends_on` 保证 postgres、migrate、web、proxy 顺序 | updater 显式执行 migrator，再切 `current symlink`，再重启 systemd 服务 |
| 升级 | `docker compose pull && docker compose up -d` | 下载并校验 artifact，解包到 `releases/<version>/`，迁移后切换 `current` |
| 回滚 | 切回旧镜像 tag 并重建容器 | 切回旧 `current` 指针并重启相关 systemd 单元 |
| 适用 | 新部署和想用容器托管全部服务的环境 | 已有 systemd、Nginx、外部 PostgreSQL 和本机更新流程的环境 |

Docker Compose 仍是 README 推荐的新部署路径。binary-style 主要服务已有成熟 systemd 发布链路、希望不拉源码也不重新构建镜像的服务器。


## M1-P2 release assets

Tag release 从 M1-P2 起会在既有 GHCR 镜像和 compose 包之外，附加 Linux x64 binary-style release assets：

```text
gpt2image-pro-<version>-linux-x64.tar.gz
gpt2image-pro-<version>-linux-x64.tar.gz.sha256
gpt2image-pro-<version>-linux-x64.zip
gpt2image-pro-<version>-linux-x64.zip.sha256
manifest.json
SHA256SUMS
```

本地生成和校验命令：

```bash
pnpm build:web
# 先在 services/chatgpt-web-proxy 构建 Linux x64 sidecar，再组装 bundle
pnpm build:binary-bundle -- --version <version> --commit <commit> --proxy-binary dist/binary-style/build/chatgpt-web-proxy
pnpm verify:binary-bundle -- --bundle-dir dist/binary-style/<version>/gpt2image-pro-<version>-linux-x64 --manifest dist/binary-style/<version>/manifest.json --artifact dist/binary-style/<version>/gpt2image-pro-<version>-linux-x64.tar.gz
sha256sum -c dist/binary-style/<version>/gpt2image-pro-<version>-linux-x64.tar.gz.sha256
sha256sum -c dist/binary-style/<version>/gpt2image-pro-<version>-linux-x64.zip.sha256
tar -tzf dist/binary-style/<version>/gpt2image-pro-<version>-linux-x64.tar.gz
unzip -l dist/binary-style/<version>/gpt2image-pro-<version>-linux-x64.zip
```

`manifest.json` release asset 是后续 updater 的校验入口，记录 version、commit、platform、artifact_url、artifact_sha256、minimum_supported_version、migration_mode、services 和 healthcheck。bundle 内也保留一份 manifest 供解包后本地查看；下载校验以 release asset 中的 detached `manifest.json` 和 `.sha256` 为准。

M1-P2 仍不包含 updater CLI，不实现本地下载、解包、切换、重启或回滚，也不实现后台 admin operation、后台 UI、Sub2API、Codex 登录、Agent 分支、批量图片工具或 PSD。

## 后续实现约束

后续 Phase 需要保持以下约束：

- Phase 2 生成的 artifact 必须能离线列出文件清单，并通过 SHA256 校验。
- Phase 3 updater dry-run 必须在不影响 `current` 的情况下完成下载、校验、解包和 env 检查。
- Phase 4 才允许真实切换、重启和自动应用层回滚。
- Phase 5 后台入口必须在本地 updater 稳定后接入，并受 admin 权限、审计、锁和显式配置保护。
