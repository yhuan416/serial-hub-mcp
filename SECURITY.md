# Security policy

## Supported versions

| Version           | Supported |
| ----------------- | --------- |
| `0.3.x`           | ✅        |
| `0.2.x` and older | ❌        |

安全修复会进最新的 `0.3.x` 补丁版本。

## Reporting a vulnerability

优先使用 GitHub 的私密报告：

<https://github.com/yhuan416/serial-hub-mcp/security/advisories/new>

也可以发邮件到 `yhuan416@foxmail.com`。请附上：

- 受影响版本（`service_info` 的版本）、部署方式（stdio / HTTP / Docker）。
- 复现步骤或最小 PoC。
- 影响范围（读/写串口、日志、凭据、拒绝服务等）。
- 是否已经在公开渠道披露。

在修复发布前，请不要公开细节。确认后会尽快回复并给出修复/缓解方案。

## Security model

- **明文链路**：远端 v1（TCP 7000）和 MCP HTTP 都是明文 + token。只应在可信 LAN、VPN 或
  SSH 隧道里使用；不要把 7000 / 8787 直接暴露到公网。
- **HTTP 鉴权**：`SERIAL_HUB_MCP_HTTP_TOKEN` 保护 `/mcp`、`/api/*` 和 `/dumps/*`；
  `/health`、`/info` 是免鉴权的、且不含密钥。
- **非回环 fail-closed**：绑定非回环地址且没有 token 时进程拒绝启动。只有显式
  `--allow-anonymous` 或 `SERIAL_HUB_MCP_HTTP_ALLOW_ANONYMOUS=1` 才会放行；此时任何能访问端口
  的人都能操作串口。
- **token 处理**：工具返回、`profile_list`、`open_list` 里的 token 会打码；`remotes.json`
  优先用 `token_env`，不要把 token 提交到 git 或写进镜像。
- **串口即执行面**：`write` / `transact` 可以驱动设备执行动作。MCP 工具只做字节传输，不对
  设备协议做安全判断；agent 和上层策略负责确认命令。
- **本地文件**：profiles、remotes、日志、dump 默认在 XDG 目录下；容器里建议把 `/config`
  只读挂载，`/data` 由单个进程独占。

## Out of scope

- 设备固件、`serial-hub-bridge` 仓库自身的问题（请在对应仓库报告）。
- 用户主动把无 token 的 HTTP 端口或明文远端暴露到公网。
- 物理接触串口/设备导致的问题。
- 依赖项的已知漏洞：请同时关注 `npm audit` 和上游公告；本项目会尽量及时升级。
