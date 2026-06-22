# TASK-003 执行摘要

## 实际修改文件

- `deploy/systemd/gpt2image-web.service.example`
- `deploy/systemd/gpt2image-chatgpt-web-proxy.service.example`
- `deploy/systemd/gpt2image-migrate.service.example`

## 验证证据

1. `Test-Path deploy/systemd/gpt2image-web.service.example`
   - 结果：PASS
   - 证据：输出 `True`。
2. `Test-Path deploy/systemd/gpt2image-chatgpt-web-proxy.service.example`
   - 结果：PASS
   - 证据：输出 `True`。
3. `Test-Path deploy/systemd/gpt2image-migrate.service.example`
   - 结果：PASS
   - 证据：输出 `True`。
4. `rg -n "WorkingDirectory=.*gpt2image/current|EnvironmentFile=/etc/gpt2image/gpt2image.env|ExecStart=.*node.*server.js" deploy/systemd/gpt2image-web.service.example`
   - 结果：PASS
   - 证据：匹配 `WorkingDirectory=/opt/gpt2image/current/apps/web/.next/standalone/apps/web`、`EnvironmentFile=/etc/gpt2image/gpt2image.env`、`ExecStart=/usr/bin/node server.js`。
5. `rg -n "ExecStart=.*chatgpt-web-proxy|CHATGPT_WEB_PROXY_BIND|3021" deploy/systemd/gpt2image-chatgpt-web-proxy.service.example`
   - 结果：PASS
   - 证据：匹配 `Environment=CHATGPT_WEB_PROXY_BIND=127.0.0.1:3021`、`ExecStart=/opt/gpt2image/current/bin/chatgpt-web-proxy`。
6. `rg -n "Type=oneshot|db:migrate|pre-switch|migration" deploy/systemd/gpt2image-migrate.service.example`
   - 结果：PASS
   - 证据：匹配 `Type=oneshot`、`pre-switch migration`、`ExecStart=/usr/bin/env pnpm --dir packages/database db:migrate`。
7. `rg -n "systemctl .*restart (postgres|nginx|caddy|docker)" deploy/systemd docs/deployment`
   - 结果：PASS
   - 证据：命令退出码为 `1`，无匹配，符合 `expected=no matches`。

## 偏离计划及原因

无。

## 备注

- 已读取 `Dockerfile.web`、`Dockerfile.chatgpt-web-proxy`、`docker-compose.yml`、`docs/deploy-nginx-ab.md` 与任务定义。
- Web 模板按 Next standalone 运行目录编写，并保留 `/opt/gpt2image/current` symlink 约束。
- Migrator 模板为 `Type=oneshot`，只作为 pre-switch migration 参考，不包含 `[Install]`，避免被启用为常驻服务。

## Orchestrator Verification

- [PASS] `Test-Path deploy/systemd/gpt2image-web.service.example`
- [PASS] `Test-Path deploy/systemd/gpt2image-chatgpt-web-proxy.service.example`
- [PASS] `Test-Path deploy/systemd/gpt2image-migrate.service.example`
- [PASS] `rg -n "WorkingDirectory=.*gpt2image/current|EnvironmentFile=/etc/gpt2image/gpt2image.env|ExecStart=.*node.*server.js" deploy/systemd/gpt2image-web.service.example`
  - evidence: 17:WorkingDirectory=/opt/gpt2image/current/apps/web/.next/standalone/apps/web | 25:EnvironmentFile=/etc/gpt2image/gpt2image.env | 26:ExecStart=/usr/bin/node server.js
- [PASS] `rg -n "ExecStart=.*chatgpt-web-proxy|CHATGPT_WEB_PROXY_BIND|3021" deploy/systemd/gpt2image-chatgpt-web-proxy.service.example`
  - evidence: 16:Environment=CHATGPT_WEB_PROXY_BIND=127.0.0.1:3021 | 19:ExecStart=/opt/gpt2image/current/bin/chatgpt-web-proxy
- [PASS] `rg -n "Type=oneshot|db:migrate|pre-switch|migration" deploy/systemd/gpt2image-migrate.service.example`
  - evidence: 1:# GPT2Image-Pro migration oneshot systemd unit example. | 2:# This is a pre-switch migration reference for updater/install flows only. | 8:Description=GPT2Image-Pro pre-switch migration | 14:Type=oneshot | 21:ExecStart=/usr/bin/env pnpm --dir packages/database db:migrate
- [PASS] `rg -n "systemctl .*restart (postgres|nginx|caddy|docker)" deploy/systemd docs/deployment`
